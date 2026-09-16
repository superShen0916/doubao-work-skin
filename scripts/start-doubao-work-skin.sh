#!/bin/bash
# 兼容入口：启动豆包工作换肤。
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
exec node "$PROJECT_ROOT/skin.mjs" start "$@"
