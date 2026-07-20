"""内部DB(catalog)の初期シード。人気の投資信託を名前検索できるよう投入する。

isin       : ISINコード（例 JP90C000H1T1）
assoc_code : 協会コード（associFundCd。例 0331418A）
category   : 分類（絞り込み・表示用）

コードは、みんかぶ・Yahoo!ファイナンス・日本経済新聞・各証券会社・投信協会ライブラリー
などの公開情報で確認したものです（8桁コード=協会コード、JP90…=ISIN）。
リストに無い投信は、アプリの「＋ 新しい投信を登録」から追加できます。
"""

SEED_FUNDS = [
    # --- eMAXIS Slim シリーズ ---
    {"name": "eMAXIS Slim 全世界株式（オール・カントリー）",
     "isin": "JP90C000H1T1", "assoc_code": "0331418A", "category": "全世界株式"},
    {"name": "eMAXIS Slim 米国株式（S&P500）",
     "isin": "JP90C000GKC6", "assoc_code": "03311187", "category": "米国株式"},
    {"name": "eMAXIS Slim 全世界株式（除く日本）",
     "isin": "JP90C000G631", "assoc_code": "03316183", "category": "全世界株式"},
    {"name": "eMAXIS Slim 先進国株式インデックス",
     "isin": "JP90C000ENC5", "assoc_code": "03319172", "category": "先進国株式"},
    {"name": "eMAXIS Slim 国内株式（TOPIX）",
     "isin": "JP90C000ENA9", "assoc_code": "03317172", "category": "国内株式"},
    {"name": "eMAXIS Slim 国内株式（日経平均）",
     "isin": "JP90C000FXV1", "assoc_code": "03311182", "category": "国内株式"},
    {"name": "eMAXIS Slim バランス（8資産均等型）",
     "isin": "JP90C000EWV6", "assoc_code": "03312175", "category": "バランス"},
    {"name": "eMAXIS Slim 新興国株式インデックス",
     "isin": "JP90C000F7H5", "assoc_code": "0331C177", "category": "新興国株式"},

    # --- SBI・V シリーズ ---
    {"name": "SBI・V・S&P500インデックス・ファンド",
     "isin": "JP90C000J569", "assoc_code": "89311199", "category": "米国株式"},
    {"name": "SBI日本高配当株式（分配）ファンド（年4回決算型）",
     "isin": "JP90C000Q9K2", "assoc_code": "8931123C", "category": "国内株式（高配当・分配型）"},
    {"name": "SBI・V・全米株式インデックス・ファンド",
     "isin": "JP90C000LY16", "assoc_code": "89311216", "category": "米国株式"},

    # --- 楽天シリーズ ---
    {"name": "楽天・全米株式インデックス・ファンド（楽天・VTI）",
     "isin": "JP90C000FHD2", "assoc_code": "9I312179", "category": "米国株式"},
    {"name": "楽天・全世界株式インデックス・ファンド（楽天・VT）",
     "isin": "JP90C000FHC4", "assoc_code": "9I311179", "category": "全世界株式"},
    {"name": "楽天・プラス・S&P500インデックス・ファンド",
     "isin": "JP90C000Q2U6", "assoc_code": "9I31223A", "category": "米国株式"},
    {"name": "楽天・プラス・SOXインデックス・ファンド",
     "isin": "JP90C000QF30", "assoc_code": "9I315241", "category": "米国株式（半導体）"},
    {"name": "楽天・プラス・オールカントリー株式インデックス・ファンド",
     "isin": "JP90C000Q2W2", "assoc_code": "9I31123A", "category": "全世界株式"},
    {"name": "楽天・プラス・NASDAQ-100インデックス・ファンド",
     "isin": "JP90C000QF22", "assoc_code": "9I314241", "category": "米国株式（NASDAQ）"},

    # --- ニッセイ / たわら / iFreeNEXT ---
    {"name": "ニッセイ外国株式インデックスファンド",
     "isin": "JP90C0009VE0", "assoc_code": "2931113C", "category": "先進国株式"},
    {"name": "ニッセイNASDAQ100インデックスファンド",
     "isin": "JP90C000PDY6", "assoc_code": "29313233", "category": "米国株式（NASDAQ）"},
    {"name": "たわらノーロード 先進国株式",
     "isin": "JP90C000CMK4", "assoc_code": "4731B15C", "category": "先進国株式"},
    {"name": "iFreeNEXT NASDAQ100インデックス",
     "isin": "JP90C000GUN2", "assoc_code": "04317188", "category": "米国株式（NASDAQ）"},
    {"name": "iFreeNEXT FANG+インデックス",
     "isin": "JP90C000FZD4", "assoc_code": "04311181", "category": "米国株式（FANG+）"},
    {"name": "ニッセイ日経225インデックスファンド",
     "isin": "JP90C0001R39", "assoc_code": "29311041", "category": "国内株式"},
    {"name": "ニッセイ・S米国グロース株式メガ10インデックスファンド（メガ10）",
     "isin": "JP90C000S9M6", "assoc_code": "2931225B", "category": "米国株式（グロース）"},

    # --- 野村 ---
    {"name": "野村インデックスファンド・外国株式（Funds-i 外国株式）",
     "isin": "JP90C0007DP8", "assoc_code": "0131410B", "category": "先進国株式"},
    {"name": "野村世界業種別投資シリーズ（世界半導体株投資）",
     "isin": "JP90C0006G52", "assoc_code": "01313098", "category": "海外株式（半導体）"},
    {"name": "野村インデックスファンド・日経半導体株（Funds-i 日経半導体株）",
     "isin": "JP90C000R9E4", "assoc_code": "0131124A", "category": "国内株式（半導体）"},

    # --- Tracers（アモーヴァ/旧日興） ---
    {"name": "Tracers MSCIオール・カントリー・ゴールドプラス",
     "isin": "JP90C000SNW3", "assoc_code": "02311263", "category": "バランス（株式＋金）"},
    {"name": "Tracers S&P500ゴールドプラス",
     "isin": "JP90C000NS46", "assoc_code": "02315228", "category": "バランス（株式＋金）"},

    # --- アクティブ / 分配型 ---
    {"name": "インベスコ 世界厳選株式オープン＜為替ヘッジなし＞（毎月決算型）（世界のベスト）",
     "isin": "JP90C0002EX1", "assoc_code": "18312991", "category": "先進国株式（分配型）"},
    {"name": "WCM 世界成長株厳選ファンド（予想分配金提示型）（ネクスト・ジェネレーション）",
     "isin": "JP90C000MED5", "assoc_code": "6831221A", "category": "世界株式（アクティブ・分配型）"},
    {"name": "アライアンス・バーンスタイン・米国成長株投信Dコース（H無・予想分配金提示型）",
     "isin": "JP90C000ATX6", "assoc_code": "39312149", "category": "米国株式（アクティブ・分配型）"},
    {"name": "ひふみプラス",
     "isin": "JP90C0008CH5", "assoc_code": "9C311125", "category": "国内外株式（アクティブ）"},
]

# --- 個別株（データはStooqの公開株価CSVから取得） ---
SEED_STOCKS = [
    {"name": "日立製作所（6501・個別株）",
     "isin": "6501.JP", "assoc_code": "", "category": "国内個別株",
     "kind": "stock", "asset_class": "非米国"},
]

# ===========================================================================
# 資産クラス分類（一覧アイコン・円グラフ・リバランス用）
# ===========================================================================

# (クラス名, アイコン, チャート色)
ASSET_CLASSES = [
    ("米国",       "🇺🇸", "#5b8def"),
    ("グローバル", "🌐", "#8b5cf6"),
    ("非米国",     "🌏", "#10b981"),
    ("高配当",     "💰", "#f59e0b"),
    ("高リターン", "🚀", "#ef4444"),
    ("バリュー",   "💎", "#0ea5e9"),
]
ASSET_CLASS_NAMES = [c[0] for c in ASSET_CLASSES]

# 理想ポートフォリオの既定値（%）。アプリの画面から変更できる。
DEFAULT_TARGETS = {
    "米国": 25, "グローバル": 30, "非米国": 15,
    "高配当": 10, "高リターン": 15, "バリュー": 5,
}


def classify(name: str, category: str = "") -> str:
    """名前・分類からの自動分類（ユーザー登録ファンド用のフォールバック）。"""
    t = f"{name} {category}"
    def has(*kws):
        return any(k in t for k in kws)
    if has("高配当", "配当"):
        return "高配当"
    if has("NASDAQ", "ナスダック", "FANG", "SOX", "半導体", "グロース", "成長", "メガ10", "レバレッジ"):
        return "高リターン"
    if has("バリュー", "割安", "厳選"):
        return "バリュー"
    if has("S&P", "S＆P", "米国", "全米", "NYダウ", "ダウ"):
        return "米国"
    if has("日本", "国内", "日経", "TOPIX", "トピックス", "新興国", "インド", "ひふみ"):
        return "非米国"
    return "グローバル"


# シードファンドの明示的な分類（協会コード→クラス）。無いものはclassify()で自動判定。
SEED_ASSET_CLASS = {
    "0331418A": "グローバル",   # Slim オルカン
    "03311187": "米国",         # Slim S&P500
    "03316183": "グローバル",   # Slim 除く日本
    "03319172": "グローバル",   # Slim 先進国
    "03317172": "非米国",       # Slim TOPIX
    "03311182": "非米国",       # Slim 日経平均
    "03312175": "グローバル",   # Slim バランス8
    "0331C177": "非米国",       # Slim 新興国
    "89311199": "米国",         # SBI・V・S&P500
    "8931123C": "高配当",       # SBI日本高配当
    "89311216": "米国",         # SBI・V・全米
    "9I312179": "米国",         # 楽天VTI
    "9I311179": "グローバル",   # 楽天VT
    "9I31223A": "米国",         # 楽天プラスS&P500
    "9I315241": "高リターン",   # 楽天プラスSOX
    "9I31123A": "グローバル",   # 楽天プラスオルカン
    "9I314241": "高リターン",   # 楽天プラスNASDAQ100
    "2931113C": "グローバル",   # ニッセイ外国株式
    "29313233": "高リターン",   # ニッセイNASDAQ100
    "29311041": "非米国",       # ニッセイ日経225
    "2931225B": "高リターン",   # メガ10
    "4731B15C": "グローバル",   # たわら先進国
    "04317188": "高リターン",   # iFreeNEXT NASDAQ100
    "04311181": "高リターン",   # iFreeNEXT FANG+
    "0131410B": "グローバル",   # Funds-i 外国株式
    "01313098": "高リターン",   # 野村 世界半導体
    "0131124A": "高リターン",   # Funds-i 日経半導体
    "02311263": "グローバル",   # Tracers AC ゴールドプラス
    "02315228": "米国",         # Tracers S&P500 ゴールドプラス
    "18312991": "バリュー",     # インベスコ 世界のベスト（割安バリュー運用）
    "6831221A": "高リターン",   # WCM（成長株厳選）
    "39312149": "高リターン",   # AB 米国成長株D
    "9C311125": "非米国",       # ひふみプラス
}

# SEED_FUNDS に asset_class / kind を付与
for _f in SEED_FUNDS:
    _f.setdefault("kind", "fund")
    _f.setdefault("asset_class",
                  SEED_ASSET_CLASS.get(_f["assoc_code"]) or classify(_f["name"], _f.get("category", "")))
for _s in SEED_STOCKS:
    _s.setdefault("kind", "stock")
