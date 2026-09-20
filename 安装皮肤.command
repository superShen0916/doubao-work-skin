#!/bin/zsh
# 仅使用 macOS 自带工具；不依赖系统 Node.js、Git、Homebrew 或开发工具。
set -eu
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS NODE_PATH
project_root="${0:A:h}"
data_root="${DWS_STATE_ROOT:-$HOME/Library/Application Support/DoubaoWorkSkin}"
runtime_version=24.21.0
case "$(uname -m)" in
  arm64) runtime_arch=arm64; expected_sha=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  x86_64) runtime_arch=x64; expected_sha=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  *) print -u2 '目前仅支持 Apple 芯片和 Intel Mac。'; exit 1 ;;
esac
if [[ ! -d /Applications/DoubaoWork.app ]]; then
  print -u2 '请先安装豆包工作，再双击此文件。'
  exit 1
fi
system_version="$(sw_vers -productVersion)"
version_parts=( ${(s:.:)system_version} )
if (( version_parts[1] < 13 || (version_parts[1] == 13 && ${version_parts[2]:-0} < 5) )); then
  print -u2 '自动安装需要 macOS 13.5 或更新版本。'
  exit 1
fi
mkdir -p "$data_root/downloads"
chmod 700 "$data_root"
archive_name="node-v${runtime_version}-darwin-${runtime_arch}.tar.gz"
archive_path="$data_root/downloads/$archive_name"
temp_dir="$(mktemp -d "$data_root/downloads/install.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
if [[ ! -f "$archive_path" ]]; then
  print '首次安装：正在下载专用运行环境（约 52 MB），不修改系统环境…'
  curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 --retry 2 \
    "https://nodejs.org/dist/v${runtime_version}/${archive_name}" -o "$temp_dir/runtime.tar.gz"
  downloaded_sha="$(shasum -a 256 "$temp_dir/runtime.tar.gz")"
  [[ "${downloaded_sha%% *}" == "$expected_sha" ]] || { print -u2 '下载校验失败，未运行下载内容。请重试。'; exit 1; }
  mv "$temp_dir/runtime.tar.gz" "$archive_path"
fi
cached_sha="$(shasum -a 256 "$archive_path")"
[[ "${cached_sha%% *}" == "$expected_sha" ]] || { print -u2 "缓存校验失败，未运行。请删除此文件后重试：$archive_path"; exit 1; }
tar -xzf "$archive_path" -C "$temp_dir"
runtime_dir="$temp_dir/node-v${runtime_version}-darwin-${runtime_arch}"
export DWS_STATE_ROOT="$data_root"
"$runtime_dir/bin/node" "$project_root/scripts/install.mjs" --runtime-dir "$runtime_dir"
print '\n安装完成。请保存工作，等 Agent 当前任务结束，再从启动台打开「豆包换肤」App（推荐，可拖到 Dock，无需确认）；也可双击桌面“豆包换肤”里的“启动豆包工作.command”。'
