#!/bin/zsh
set -eu
data_root="${DWS_STATE_ROOT:-$HOME/Library/Application Support/DoubaoWorkSkin}"
launcher="$data_root/启动入口/启动豆包工作.command"
if [[ ! -x "$launcher" ]]; then
  print '请先双击同一文件夹中的“安装皮肤.command”，无需自行安装 Node.js。'
  exit 1
fi
exec "$launcher" "$@"
