#!/bin/bash
# 兼容入口：停止 watch，并按参数决定是否恢复官方外观。
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
exec node "$PROJECT_ROOT/skin.mjs" stop "$@"
