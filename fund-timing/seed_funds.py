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
