#!/usr/bin/env bash
# F1〜F6 の体感の受入の試験を、OpenClaw の作業木（A: v2026.9.6+base_series / B: v2026.9.7）で回す。
#   使い方: run.sh <作業木のパス> <出力のラベル(A|B)> [vitest に渡す絞り込み(例: f1)]
# 試験は <作業木>/test/ixg-taikan/ に写して走らせる（その作業木の src を import する）。結果は out/<ラベル>.json（ラベルは自由。例 A_f2）。
set -euo pipefail
TREE="$(cd "${1:?tree path}" && pwd)"
LABEL="${2:?label A or B}"
FILTER="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$TREE/test/ixg-taikan" "$HERE/out"
FILES=()
for f in $(cd "$HERE/tests" && ls | grep -E "^${FILTER}.*\.test\.ts$"); do
  cp "$HERE/tests/$f" "$TREE/test/ixg-taikan/$f"      # 絞り込んだ試験だけを写す（他の試験の書きかけを巻き込まない）
  FILES+=("test/ixg-taikan/$f")
done
# 試験が使う補助（*.support.ts）は常に写す
for f in $(cd "$HERE/tests" && ls | grep -E "\.support\.ts$" || true); do cp "$HERE/tests/$f" "$TREE/test/ixg-taikan/$f"; done
export IXG_TAIKAN_RECORD_DIR="$HERE/out"
cd "$TREE"
set +e
node_modules/.bin/vitest run --reporter=json --outputFile="$HERE/out/$LABEL.json" "${FILES[@]}" >"$HERE/out/$LABEL.log" 2>&1
CODE=$?
set -e
node "$HERE/summarize.mjs" "$HERE/out/$LABEL.json" "$LABEL"
exit 0
