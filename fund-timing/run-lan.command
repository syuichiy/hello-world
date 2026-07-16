#!/bin/bash
# 他の端末（同じWi-Fi内のスマホ等）からもアクセスできるように起動します。
# ダブルクリックで実行してください。起動後、ターミナルに表示される
#   http://<このMacのIP>:8765
# を、他の端末のブラウザで開いてください（同じWi-Fiに接続していること）。
set -e
cd "$(dirname "$0")"

PY="python3"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python3 が見つかりません。https://www.python.org/ からインストールしてください。"
  read -r -p "Enterキーで閉じます..." _
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "初回セットアップ中（少しかかります）..."
  "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip >/dev/null
  ./.venv/bin/pip install -r requirements.txt
fi

echo "他の端末からもアクセスできるモードで起動します。"
exec ./.venv/bin/python app.py --lan "$@"
