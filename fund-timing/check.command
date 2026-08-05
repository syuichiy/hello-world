#!/bin/bash
# 株価の取得状況を調べる診断ツールのランチャー。
# run.command と同じ仕組みで仮想環境(.venv)を用意してから check_stock.py を動かします。
# ダブルクリックでも、ターミナルで ./check.command でも実行できます。
# ティッカーを指定したいときは:  ./check.command 6501.JP
set -e
cd "$(dirname "$0")"

PY=""
for cand in python3.13 python3.12 python3.11 python3.10 \
            /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1; then PY="python3"; else
    echo "Python3 が見つかりません。https://www.python.org/ からインストールしてください。"
    read -r -p "Enterキーで閉じます..." _
    exit 1
  fi
fi

if [ ! -d ".venv" ]; then
  echo "初回セットアップ中（少しかかります）..."
  "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip >/dev/null
  ./.venv/bin/pip install -r requirements.txt
fi

./.venv/bin/python check_stock.py "$@"
echo
read -r -p "Enterキーで閉じます..." _
