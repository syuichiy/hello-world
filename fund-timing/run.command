#!/bin/bash
# Macで「ダブルクリック」して起動するためのランチャー。
# 初回だけ仮想環境を作って必要なライブラリを入れ、以降はすぐ起動します。
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

echo "アプリを起動します。ブラウザが自動で開きます。"
echo "終了するにはこのウィンドウで Ctrl+C を押してください。"
exec ./.venv/bin/python app.py "$@"
