#!/usr/bin/env bash
# 编译合并引擎及其依赖到临时目录并运行纯函数测试，随后清理。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

"$ROOT/node_modules/.bin/tsc" \
  "$ROOT/src/lib/merge.ts" \
  "$ROOT/src/lib/markdown.ts" \
  "$ROOT/src/lib/seed.ts" \
  "$ROOT/src/lib/types.ts" \
  "$ROOT/src/lib/utils.ts" \
  --outDir "$OUT" \
  --module commonjs \
  --target ES2020 \
  --moduleResolution node \
  --skipLibCheck \
  --esModuleInterop

MERGE_TEST_OUT="$OUT" node "$ROOT/scripts/merge-test.js"
