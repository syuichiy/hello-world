"""内部DB(catalog)の初期シード。人気の投資信託を名前検索できるよう投入する。

isin       : ISINコード（例 JP90C000H1T1）
assoc_code : 協会コード（associFundCd。例 0331418A）
category   : 分類（絞り込み・表示用）

※ コードは将来変更される可能性があります。分析でうまく取得できない場合は、
   アプリの検索欄から「＋ 新しい投信を登録」で、投信総合検索ライブラリー
   (https://toushin-lib.fwg.ne.jp/) のURLを貼り付けて登録してください。
   登録した投信はこの内部DB(funds.db)に保存され、次回以降も名前で検索できます。
"""

SEED_FUNDS = [
    {
        "name": "eMAXIS Slim 全世界株式（オール・カントリー）",
        "isin": "JP90C000H1T1", "assoc_code": "0331418A", "category": "全世界株式",
    },
    {
        "name": "eMAXIS Slim 米国株式（S&P500）",
        "isin": "JP90C000GKC6", "assoc_code": "03311187", "category": "米国株式",
    },
    {
        "name": "eMAXIS Slim 先進国株式インデックス",
        "isin": "JP90C000FZ97", "assoc_code": "03311112", "category": "先進国株式",
    },
    {
        "name": "eMAXIS Slim バランス（8資産均等型）",
        "isin": "JP90C000FYS4", "assoc_code": "03311107", "category": "バランス",
    },
    {
        "name": "SBI・V・S&P500インデックス・ファンド",
        "isin": "JP90C000H4Z3", "assoc_code": "89311199", "category": "米国株式",
    },
]
