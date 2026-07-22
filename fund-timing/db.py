"""内部DB（SQLite）。ファンドのカタログ・ウォッチリスト・価格キャッシュを保持する。

テーブル:
  catalog   … 投資信託の一覧（名前・ISIN・協会コード・分類）。名前検索の対象。
  watchlist … 一覧ビューに並べるファンド（catalog を参照）。
  cache     … 取得済みの基準価額シリーズ（JSON）。ネットワーク負荷軽減のためのキャッシュ。
"""
from __future__ import annotations

import json
import os
import sqlite3
import datetime as dt
from typing import Optional

import seed_funds


def _default_db_path() -> str:
    """アプリ更新（フォルダ入れ替え）でも消えないよう、ホーム直下に保存する。"""
    base = os.path.join(os.path.expanduser("~"), ".fund-timing")
    return os.path.join(base, "funds.db")


# アプリ本体と別の場所（ホーム）に保存 → フォルダを差し替えても引き継がれる
DB_PATH = _default_db_path()
# 旧バージョンがアプリ内に作った funds.db（あれば初回に引き継ぐ）
LEGACY_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "funds.db")
CACHE_TTL_HOURS = 12


def _ensure_parent(path: str):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)


def _conn(db_path: Optional[str] = None):
    path = db_path or DB_PATH
    _ensure_parent(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _maybe_migrate_legacy(path: str):
    """新しい保存先が空で、旧フォルダ内の funds.db がある場合は引き継ぐ。"""
    if os.path.exists(path):
        return
    legacy = LEGACY_DB_PATH
    if os.path.exists(legacy) and os.path.abspath(legacy) != os.path.abspath(path):
        try:
            import shutil
            _ensure_parent(path)
            shutil.copy2(legacy, path)
            print(f"以前の登録内容を引き継ぎました: {legacy} → {path}")
        except Exception as e:
            print(f"旧DBの引き継ぎに失敗しました（新規作成します）: {e}")


def init_db(db_path: Optional[str] = None, seed: bool = True):
    path = db_path or DB_PATH
    _maybe_migrate_legacy(path)
    with _conn(path) as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS catalog (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                isin       TEXT NOT NULL,
                assoc_code TEXT NOT NULL,
                category   TEXT DEFAULT '',
                UNIQUE(isin, assoc_code)
            );
            CREATE TABLE IF NOT EXISTS watchlist (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                catalog_id INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                added_at   TEXT,
                FOREIGN KEY(catalog_id) REFERENCES catalog(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS cache (
                isin        TEXT NOT NULL,
                assoc_code  TEXT NOT NULL,
                name        TEXT,
                series_json TEXT NOT NULL,
                fetched_at  TEXT NOT NULL,
                PRIMARY KEY(isin, assoc_code)
            );
            CREATE INDEX IF NOT EXISTS idx_catalog_name ON catalog(name);

            -- 取引履歴（実額）ポートフォリオ。価格推移タブの正確な推移に使う。
            CREATE TABLE IF NOT EXISTS actual_holding (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                fund_name   TEXT DEFAULT '',
                isin        TEXT DEFAULT '',
                assoc_code  TEXT DEFAULT '',
                asset_class TEXT DEFAULT '',
                broker      TEXT DEFAULT '',
                sell_policy TEXT DEFAULT 'full',
                invested    REAL DEFAULT 0,
                sort_order  INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS actual_amount (
                holding_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                amount     REAL,
                PRIMARY KEY(holding_id, date)
            );
            -- 保有(watchlist)ごとの日次評価額（実額）の履歴。価格推移タブに使う。
            CREATE TABLE IF NOT EXISTS amount_history (
                watch_id INTEGER NOT NULL,
                date     TEXT NOT NULL,
                amount   REAL,
                PRIMARY KEY(watch_id, date)
            );
            """
        )
        # マイグレーション: 保有口数カラム（旧バージョンのDBに追加）
        cols = [r["name"] for r in c.execute("PRAGMA table_info(watchlist)")]
        if "units" not in cols:
            c.execute("ALTER TABLE watchlist ADD COLUMN units REAL DEFAULT 0")
        if "sell_policy" not in cols:
            # 売却属性: full=売却可能 / partial=一部売却可能 / locked=売却不可
            c.execute("ALTER TABLE watchlist ADD COLUMN sell_policy TEXT DEFAULT 'full'")
        if "broker" not in cols:
            # 保有先の証券会社（SBI証券 / 楽天証券 / 三菱UFJスマート証券 / 空=未設定）
            c.execute("ALTER TABLE watchlist ADD COLUMN broker TEXT DEFAULT ''")
        if "invested" not in cols:
            # 投資金額（元本）。価格推移グラフの「評価額÷投資金額」比率に使う
            c.execute("ALTER TABLE watchlist ADD COLUMN invested REAL DEFAULT 0")
        if "label" not in cols:
            # 保有ごとの表示名（口座名など）。同一ファンドを別口座で持つ時の区別用。空=カタログ名
            c.execute("ALTER TABLE watchlist ADD COLUMN label TEXT DEFAULT ''")
        # マイグレーション: 同一商品を複数の証券会社で保有できるよう、
        # 旧スキーマの UNIQUE(catalog_id) 制約を外す（テーブル再構築）。
        idxs = c.execute("PRAGMA index_list(watchlist)").fetchall()
        if any((r["origin"] == "u") for r in idxs):
            c.executescript(
                """
                CREATE TABLE watchlist_new (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    catalog_id INTEGER NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    added_at   TEXT,
                    units      REAL DEFAULT 0,
                    sell_policy TEXT DEFAULT 'full',
                    broker     TEXT DEFAULT '',
                    invested   REAL DEFAULT 0,
                    label      TEXT DEFAULT '',
                    FOREIGN KEY(catalog_id) REFERENCES catalog(id) ON DELETE CASCADE
                );
                INSERT INTO watchlist_new(id, catalog_id, sort_order, added_at, units, sell_policy, broker, invested, label)
                    SELECT id, catalog_id, sort_order, added_at,
                           COALESCE(units, 0), COALESCE(sell_policy, 'full'),
                           COALESCE(broker, ''), COALESCE(invested, 0), COALESCE(label, '')
                    FROM watchlist;
                DROP TABLE watchlist;
                ALTER TABLE watchlist_new RENAME TO watchlist;
                """
            )
        # マイグレーション: 資産クラス・商品種別（投信/個別株）
        ccols = [r["name"] for r in c.execute("PRAGMA table_info(catalog)")]
        if "asset_class" not in ccols:
            c.execute("ALTER TABLE catalog ADD COLUMN asset_class TEXT DEFAULT ''")
        if "kind" not in ccols:
            c.execute("ALTER TABLE catalog ADD COLUMN kind TEXT DEFAULT 'fund'")
        # 設定（理想ポートフォリオ等）
        c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
        # 一度だけ: 旧版が自動推定で入れた「端数付きの口数」をクリアし、画面入力に委ねる。
        # ユーザーが入力した整数の口数はそのまま残す。
        done = c.execute("SELECT value FROM settings WHERE key='clear_derived_units_v1'").fetchone()
        if not done:
            c.execute("UPDATE watchlist SET units=0 "
                      "WHERE units IS NOT NULL AND units <> CAST(units AS INTEGER)")
            c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('clear_derived_units_v1', '1')")
    if seed:
        seed_catalog(db_path)
        _seed_default_watchlist(db_path)
        _ensure_seed_stocks_watched(db_path)
        import_actual_portfolio(db_path)


# 取引履歴（実額）ポートフォリオの取り込み元（アプリに同梱）
_PORTFOLIO_SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "portfolio_seed.json")


def import_actual_portfolio(db_path: Optional[str] = None):
    """同梱の portfolio_seed.json（ユーザー提供の取引履歴・実額）を一度だけ取り込む。"""
    if not os.path.exists(_PORTFOLIO_SEED):
        return False
    try:
        data = json.load(open(_PORTFOLIO_SEED, encoding="utf-8"))
    except Exception:
        return False
    products = data.get("products", [])

    def _clean_history(hist):
        """明らかな外れ値（桁落ち等）を欠測扱いにする。中央値の0.25〜4倍の範囲外を除外。"""
        pairs = []
        for d, a in (hist or {}).items():
            try:
                a = float(a)
            except (TypeError, ValueError):
                continue
            if a > 0:
                pairs.append((d, a))
        if len(pairs) < 3:
            return pairs
        vals = sorted(a for _, a in pairs)
        med = vals[len(vals) // 2]
        lo, hi = med * 0.25, med * 4
        return [(d, a) for d, a in pairs if lo <= a <= hi]

    with _conn(db_path) as c:
        done = c.execute("SELECT value FROM settings WHERE key='portfolio_import_v2'").fetchone()
        if done:
            return False
        # 未使用の既定シード保有（口数・投資金額とも未設定）を片付けてから、実ポートフォリオを投入
        c.execute("DELETE FROM watchlist WHERE COALESCE(units,0)=0 AND COALESCE(invested,0)=0 "
                  "AND id NOT IN (SELECT DISTINCT watch_id FROM amount_history)")
        base = c.execute("SELECT COALESCE(MAX(sort_order), -1) FROM watchlist").fetchone()[0]
        for i, p in enumerate(products):
            isin = (p.get("isin") or "").strip().upper()
            assoc = (p.get("assoc_code") or "").strip()
            fund_name = p.get("fund_name") or p.get("name") or ""
            # カタログに紐付け（既存の内蔵ファンドがあれば再利用、無ければ作成）
            row = c.execute("SELECT id FROM catalog WHERE isin=? AND assoc_code=?", (isin, assoc)).fetchone()
            if row:
                cat_id = row["id"]
            else:
                cur = c.execute(
                    "INSERT INTO catalog(name, isin, assoc_code, category, asset_class, kind) "
                    "VALUES (?,?,?,?,?,?)",
                    (fund_name, isin, assoc, "", p.get("asset_class", ""), "fund"))
                cat_id = cur.lastrowid
            cur = c.execute(
                "INSERT INTO watchlist(catalog_id, sort_order, added_at, broker, sell_policy, invested, label) "
                "VALUES (?,?,?,?,?,?,?)",
                (cat_id, base + 1 + i, dt.datetime.now().isoformat(timespec="seconds"),
                 p.get("broker", ""), p.get("sell_policy", "full"), float(p.get("invested") or 0),
                 p.get("name", "")))
            wid = cur.lastrowid
            for d, a in _clean_history(p.get("history")):
                c.execute("INSERT OR REPLACE INTO amount_history(watch_id, date, amount) VALUES (?,?,?)",
                          (wid, d, a))
        c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('portfolio_import_v2', '1')")
    return True


# ------------------------------------------------------------ 評価額の履歴（実額）
def get_amount_history(watch_id: int, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        rows = c.execute("SELECT date, amount FROM amount_history WHERE watch_id=? ORDER BY date",
                         (watch_id,)).fetchall()
        return {r["date"]: r["amount"] for r in rows}


def get_all_amount_histories(db_path: Optional[str] = None):
    """{watch_id: {date: amount}} を返す。"""
    with _conn(db_path) as c:
        out: dict = {}
        for r in c.execute("SELECT watch_id, date, amount FROM amount_history ORDER BY watch_id, date"):
            out.setdefault(r["watch_id"], {})[r["date"]] = r["amount"]
        return out


def upsert_amount(watch_id: int, date: str, amount: float, db_path: Optional[str] = None):
    """ある日付の評価額を登録/更新（0以下や空で削除）。ページロード時の当日更新に使う。"""
    with _conn(db_path) as c:
        if amount is None or float(amount) <= 0:
            c.execute("DELETE FROM amount_history WHERE watch_id=? AND date=?", (watch_id, date))
        else:
            c.execute("INSERT OR REPLACE INTO amount_history(watch_id, date, amount) VALUES (?,?,?)",
                      (watch_id, date, float(amount)))


def seed_catalog(db_path: Optional[str] = None):
    """既定の人気投信・個別株を投入する。毎回 INSERT OR IGNORE で「不足分だけ」追加するので、
    アプリを新しい版に更新すると、増えた内蔵銘柄が既存DBにも自動で反映される
    （ユーザーが自分で登録した投信は UNIQUE 制約により保持される）。"""
    with _conn(db_path) as c:
        for f in seed_funds.SEED_FUNDS + seed_funds.SEED_STOCKS:
            c.execute(
                "INSERT OR IGNORE INTO catalog(name, isin, assoc_code, category, asset_class, kind) "
                "VALUES (?,?,?,?,?,?)",
                (f["name"], f["isin"], f["assoc_code"], f.get("category", ""),
                 f.get("asset_class", ""), f.get("kind", "fund")),
            )
            # 既存行の資産クラス・種別を補完（旧バージョンのDBに反映）
            c.execute(
                "UPDATE catalog SET asset_class=?, kind=? "
                "WHERE isin=? AND assoc_code=? AND (asset_class IS NULL OR asset_class='')",
                (f.get("asset_class", ""), f.get("kind", "fund"), f["isin"], f["assoc_code"]),
            )
        # ユーザー登録分など、まだ分類が無い行はキーワードで自動分類
        for r in c.execute("SELECT id, name, category FROM catalog "
                           "WHERE asset_class IS NULL OR asset_class=''").fetchall():
            c.execute("UPDATE catalog SET asset_class=? WHERE id=?",
                      (seed_funds.classify(r["name"], r["category"] or ""), r["id"]))
        # 分類の見直し（毎月分配型→高配当 等）。一度だけ実行し、以後はユーザーの
        # 手動変更を尊重する（フラグで一度きりに限定）。
        done = c.execute("SELECT value FROM settings WHERE key='reclassify_v1'").fetchone()
        if not done:
            for assoc, old_cls, new_cls in getattr(seed_funds, "RECLASSIFY", []):
                c.execute("UPDATE catalog SET asset_class=? WHERE assoc_code=? AND asset_class=?",
                          (new_cls, assoc, old_cls))
            c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('reclassify_v1', '1')")


def _ensure_seed_stocks_watched(db_path: Optional[str] = None):
    """日立製作所などの内蔵個別株をポートフォリオ（ウォッチリスト）へ自動で組み込む。

    ※ 既定ウォッチリストの投入後に呼ぶこと（先に呼ぶと初期リストがこれだけになる）。"""
    with _conn(db_path) as c:
        for s in seed_funds.SEED_STOCKS:
            row = c.execute("SELECT id FROM catalog WHERE isin=? AND assoc_code=?",
                            (s["isin"], s["assoc_code"])).fetchone()
            if not row:
                continue
            # UNIQUE制約を外したので、既に保有していないか明示的に確認して重複を防ぐ
            already = c.execute("SELECT 1 FROM watchlist WHERE catalog_id=?", (row["id"],)).fetchone()
            if already:
                continue
            c.execute("INSERT INTO watchlist(catalog_id, sort_order, added_at) "
                      "VALUES (?, (SELECT COALESCE(MAX(sort_order),-1)+1 FROM watchlist), ?)",
                      (row["id"], dt.datetime.now().isoformat(timespec="seconds")))


# ------------------------------------------------------------------ settings
def get_setting(key: str, default=None, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if r is None:
            return default
        try:
            return json.loads(r["value"])
        except Exception:
            return default


def set_setting(key: str, value, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)",
                  (key, json.dumps(value)))


def _seed_default_watchlist(db_path: Optional[str] = None):
    """ウォッチリストが空なら、先頭数件を初期表示として登録する。"""
    with _conn(db_path) as c:
        n = c.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0]
        if n > 0:
            return
        rows = c.execute("SELECT id FROM catalog ORDER BY id LIMIT 4").fetchall()
        for i, r in enumerate(rows):
            c.execute(
                "INSERT OR IGNORE INTO watchlist(catalog_id, sort_order, added_at) VALUES (?,?,?)",
                (r["id"], i, dt.datetime.now().isoformat(timespec="seconds")),
            )


# ------------------------------------------------------------------ catalog
def search_catalog(query: str, limit: int = 30, db_path: Optional[str] = None):
    query = (query or "").strip()
    with _conn(db_path) as c:
        if not query:
            rows = c.execute(
                "SELECT * FROM catalog ORDER BY name LIMIT ?", (limit,)
            ).fetchall()
        else:
            like = f"%{query}%"
            rows = c.execute(
                "SELECT * FROM catalog WHERE name LIKE ? OR isin LIKE ? "
                "ORDER BY name LIMIT ?",
                (like, like, limit),
            ).fetchall()
        return [dict(r) for r in rows]


def get_catalog(catalog_id: int, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        r = c.execute("SELECT * FROM catalog WHERE id=?", (catalog_id,)).fetchone()
        return dict(r) if r else None


def add_catalog(name: str, isin: str, assoc_code: str, category: str = "",
                db_path: Optional[str] = None):
    """カタログに投信を追加（既存なら名前を更新）。追加/既存のcatalog行を返す。"""
    name = (name or "").strip()
    isin = (isin or "").strip().upper()
    assoc_code = (assoc_code or "").strip()
    if not isin and not assoc_code:
        raise ValueError("協会コード（8桁）またはISINコードが必要です。")
    if not name:
        name = isin or assoc_code
    with _conn(db_path) as c:
        existing = c.execute(
            "SELECT * FROM catalog WHERE isin=? AND assoc_code=?", (isin, assoc_code)
        ).fetchone()
        if existing:
            if name and name != existing["name"] and name != isin:
                c.execute("UPDATE catalog SET name=? WHERE id=?", (name, existing["id"]))
            row_id = existing["id"]
        else:
            cur = c.execute(
                "INSERT INTO catalog(name, isin, assoc_code, category) VALUES (?,?,?,?)",
                (name, isin, assoc_code, category),
            )
            row_id = cur.lastrowid
        # 同一コネクション内で読み戻す（別コネクションだと未コミットで見えないため）
        r = c.execute("SELECT * FROM catalog WHERE id=?", (row_id,)).fetchone()
        return dict(r) if r else None


def delete_catalog(catalog_id: int, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        c.execute("DELETE FROM catalog WHERE id=?", (catalog_id,))


# ------------------------------------------------------------------ watchlist
def list_watchlist(db_path: Optional[str] = None):
    with _conn(db_path) as c:
        rows = c.execute(
            "SELECT w.id AS watch_id, w.sort_order, w.units, w.sell_policy, w.broker, "
            "w.invested, w.label, c.* "
            "FROM watchlist w JOIN catalog c ON c.id = w.catalog_id "
            "ORDER BY w.sort_order, w.id"
        ).fetchall()
        return [dict(r) for r in rows]


def list_catalog(db_path: Optional[str] = None):
    """カタログ（内蔵＋登録済み）の全商品を返す。プリセット商品の追加UI用。"""
    with _conn(db_path) as c:
        rows = c.execute("SELECT * FROM catalog ORDER BY kind, name").fetchall()
        return [dict(r) for r in rows]


def set_units(watch_id: int, units: float, db_path: Optional[str] = None):
    """保有口数を設定する（0で未保有扱い）。watch_id は保有行（watchlist.id）。"""
    units = max(0.0, float(units or 0))
    with _conn(db_path) as c:
        c.execute("UPDATE watchlist SET units=? WHERE id=?", (units, watch_id))
    return units


def set_invested(watch_id: int, invested: float, db_path: Optional[str] = None):
    """投資金額（元本）を設定する。watch_id は保有行（watchlist.id）。"""
    invested = max(0.0, float(invested or 0))
    with _conn(db_path) as c:
        c.execute("UPDATE watchlist SET invested=? WHERE id=?", (invested, watch_id))
    return invested


def set_asset_class(catalog_id: int, asset_class: str, db_path: Optional[str] = None):
    """商品の資産クラス（分類）を手動で変更する。"""
    if asset_class not in seed_funds.ASSET_CLASS_NAMES:
        raise ValueError("不正な資産クラスです。")
    with _conn(db_path) as c:
        c.execute("UPDATE catalog SET asset_class=? WHERE id=?", (asset_class, catalog_id))
    return asset_class


def set_broker(watch_id: int, broker: str, db_path: Optional[str] = None):
    """保有先の証券会社を設定する（空文字で未設定）。watch_id は保有行（watchlist.id）。"""
    broker = (broker or "").strip()
    if broker and broker not in seed_funds.BROKERS:
        raise ValueError("不正な証券会社です。")
    with _conn(db_path) as c:
        c.execute("UPDATE watchlist SET broker=? WHERE id=?", (broker, watch_id))
    return broker


SELL_POLICIES = ("full", "partial", "locked")


def set_sell_policy(watch_id: int, policy: str, db_path: Optional[str] = None):
    """売却属性を設定する（full=売却可能 / partial=一部売却可能 / locked=売却不可）。
    watch_id は保有行（watchlist.id）。"""
    if policy not in SELL_POLICIES:
        raise ValueError("policy は full / partial / locked のいずれかです。")
    with _conn(db_path) as c:
        c.execute("UPDATE watchlist SET sell_policy=? WHERE id=?", (policy, watch_id))
    return policy


def add_watch(catalog_id: int, broker: str = "", db_path: Optional[str] = None):
    """保有を1件追加する。同じ商品でも証券会社が違えば別の保有として追加できる。
    同一商品×同一証券会社の重複だけは追加しない。"""
    broker = (broker or "").strip()
    if broker and broker not in seed_funds.BROKERS:
        broker = ""
    with _conn(db_path) as c:
        exists = c.execute(
            "SELECT id FROM watchlist WHERE catalog_id=? AND broker=?", (catalog_id, broker)
        ).fetchone()
        if exists:
            return False   # 同じ商品・同じ証券会社は重複追加しない
        mx = c.execute("SELECT COALESCE(MAX(sort_order), -1) FROM watchlist").fetchone()[0]
        c.execute(
            "INSERT INTO watchlist(catalog_id, sort_order, added_at, broker) VALUES (?,?,?,?)",
            (catalog_id, mx + 1, dt.datetime.now().isoformat(timespec="seconds"), broker),
        )
        return True


def remove_watch(watch_id: int, db_path: Optional[str] = None):
    """保有を1件削除する（watch_id は watchlist.id）。評価額履歴も一緒に削除。"""
    with _conn(db_path) as c:
        c.execute("DELETE FROM watchlist WHERE id=?", (watch_id,))
        c.execute("DELETE FROM amount_history WHERE watch_id=?", (watch_id,))


# ------------------------------------------------------------------ cache
def get_cached_series(isin: str, assoc_code: str, max_age_hours: int = CACHE_TTL_HOURS,
                      db_path: Optional[str] = None):
    with _conn(db_path) as c:
        r = c.execute(
            "SELECT * FROM cache WHERE isin=? AND assoc_code=?", (isin, assoc_code)
        ).fetchone()
        if not r:
            return None
        try:
            fetched = dt.datetime.fromisoformat(r["fetched_at"])
        except ValueError:
            return None
        age = dt.datetime.now() - fetched
        if age > dt.timedelta(hours=max_age_hours):
            return None
        return json.loads(r["series_json"])


def set_cached_series(isin: str, assoc_code: str, name: str, series: dict,
                      db_path: Optional[str] = None):
    with _conn(db_path) as c:
        c.execute(
            "INSERT OR REPLACE INTO cache(isin, assoc_code, name, series_json, fetched_at) "
            "VALUES (?,?,?,?,?)",
            (isin, assoc_code, name, json.dumps(series),
             dt.datetime.now().isoformat(timespec="seconds")),
        )


def clear_cache(db_path: Optional[str] = None):
    with _conn(db_path) as c:
        c.execute("DELETE FROM cache")
