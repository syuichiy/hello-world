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
                catalog_id INTEGER NOT NULL UNIQUE,
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
            """
        )
        # マイグレーション: 保有口数カラム（旧バージョンのDBに追加）
        cols = [r["name"] for r in c.execute("PRAGMA table_info(watchlist)")]
        if "units" not in cols:
            c.execute("ALTER TABLE watchlist ADD COLUMN units REAL DEFAULT 0")
        # マイグレーション: 資産クラス・商品種別（投信/個別株）
        ccols = [r["name"] for r in c.execute("PRAGMA table_info(catalog)")]
        if "asset_class" not in ccols:
            c.execute("ALTER TABLE catalog ADD COLUMN asset_class TEXT DEFAULT ''")
        if "kind" not in ccols:
            c.execute("ALTER TABLE catalog ADD COLUMN kind TEXT DEFAULT 'fund'")
        # 設定（理想ポートフォリオ等）
        c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    if seed:
        seed_catalog(db_path)
        _seed_default_watchlist(db_path)
        _ensure_seed_stocks_watched(db_path)


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


def _ensure_seed_stocks_watched(db_path: Optional[str] = None):
    """日立製作所などの内蔵個別株をポートフォリオ（ウォッチリスト）へ自動で組み込む。

    ※ 既定ウォッチリストの投入後に呼ぶこと（先に呼ぶと初期リストがこれだけになる）。"""
    with _conn(db_path) as c:
        for s in seed_funds.SEED_STOCKS:
            row = c.execute("SELECT id FROM catalog WHERE isin=? AND assoc_code=?",
                            (s["isin"], s["assoc_code"])).fetchone()
            if row:
                c.execute("INSERT OR IGNORE INTO watchlist(catalog_id, sort_order, added_at) "
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
            "SELECT w.id AS watch_id, w.sort_order, w.units, c.* "
            "FROM watchlist w JOIN catalog c ON c.id = w.catalog_id "
            "ORDER BY w.sort_order, w.id"
        ).fetchall()
        return [dict(r) for r in rows]


def set_units(catalog_id: int, units: float, db_path: Optional[str] = None):
    """保有口数を設定する（0で未保有扱い）。"""
    units = max(0.0, float(units or 0))
    with _conn(db_path) as c:
        c.execute("UPDATE watchlist SET units=? WHERE catalog_id=?", (units, catalog_id))
    return units


def add_watch(catalog_id: int, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        exists = c.execute("SELECT id FROM watchlist WHERE catalog_id=?", (catalog_id,)).fetchone()
        if exists:
            return False
        mx = c.execute("SELECT COALESCE(MAX(sort_order), -1) FROM watchlist").fetchone()[0]
        c.execute(
            "INSERT INTO watchlist(catalog_id, sort_order, added_at) VALUES (?,?,?)",
            (catalog_id, mx + 1, dt.datetime.now().isoformat(timespec="seconds")),
        )
        return True


def remove_watch(catalog_id: int, db_path: Optional[str] = None):
    with _conn(db_path) as c:
        c.execute("DELETE FROM watchlist WHERE catalog_id=?", (catalog_id,))


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
