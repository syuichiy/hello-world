#!/bin/bash
# Macで「ダブルクリック」して起動するためのランチャー。
# 初回だけ仮想環境を作って必要なライブラリを入れ、以降はすぐ起動します。
set -e
cd "$(dirname "$0")"

# なるべく新しいPythonを探す（株価取得のyfinanceにはPython 3.10以上が必要）。
# AnacondaのbaseなどはPythonが古いことがあるため、公式/Homebrew系を優先する。
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

PYVER=$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "使用するPython: $PY (バージョン $PYVER)"
if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then :; else
  echo "⚠️ Python $PYVER は古いため、個別株の株価取得（yfinance）が使えません。"
  echo "   https://www.python.org/ から最新のPython3を入れると自動で使われます。"
fi

# 既存の .venv が古いPythonで作られていた場合は作り直す
if [ -d ".venv" ] && ! ./.venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
  if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then
    echo "古いPythonで作られた環境を作り直します..."
    rm -rf .venv
  fi
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
