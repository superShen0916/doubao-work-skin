#!/bin/bash
# 兼容入口：运行职责由 skin.mjs / runtime.mjs 统一管理。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
exec node "$PROJECT_ROOT/skin.mjs" "$@"
