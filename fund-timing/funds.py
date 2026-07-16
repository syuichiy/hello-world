"""人気の投資信託のプリセット。

isin       : ISINコード（例 JP90C000H1T1）
assoc_code : 協会コード（associFundCd。例 0331418A）

※ コードは変更される可能性があります。プリセットでうまく取得できない場合は、
   投信総合検索ライブラリー(https://toushin-lib.fwg.ne.jp/) で対象ファンドを開き、
   そのページのURL（isinCd と associFundCd を含む）をアプリに貼り付けてください。
"""

PRESET_FUNDS = [
    {
        "name": "eMAXIS Slim 全世界株式（オール・カントリー）",
        "isin": "JP90C000H1T1",
        "assoc_code": "0331418A",
    },
    {
        "name": "eMAXIS Slim 米国株式（S&P500）",
        "isin": "JP90C000GKC6",
        "assoc_code": "03311187",
    },
    {
        "name": "eMAXIS Slim 先進国株式インデックス",
        "isin": "JP90C000FZ97",
        "assoc_code": "03311112",
    },
    {
        "name": "eMAXIS Slim バランス（8資産均等型）",
        "isin": "JP90C000FYS4",
        "assoc_code": "03311107",
    },
    {
        "name": "SBI・V・S&P500インデックス・ファンド",
        "isin": "JP90C000H4Z3",
        "assoc_code": "89311199",
    },
]
