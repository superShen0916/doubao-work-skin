#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateReleaseTag(tag, version) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) || tag !== `v${version}`) {
    throw new Error(`发布 tag ${tag} 必须与 package.json 的 v${version} 一致，且为正式版本`);
  }
}

export async function verifyRelease(args = []) {
  if (args.length && !(args.length === 2 && ["--tag", "--tag-only"].includes(args[0]))) {
    throw new Error("用法: node scripts/verify-release.mjs [--tag|--tag-only vX.Y.Z]");
  }
  const { version } = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  if (args.length) {
    validateReleaseTag(args[1], version);
    const notes = await fs.readFile(path.join(ROOT, "docs/releases", `${args[1]}.md`), "utf8");
    if (!notes.trim()) throw new Error("发布说明不能为空");
    if (args[0] === "--tag-only") return;
  }
  // 跨平台找 python
  const python = (() => { for (const b of ["python3", "python"]) { try { execFileSync(b, ["--version"], { stdio: "ignore" }); return b; } catch {} } throw new Error("需要 python3 或 python"); })();
  execFileSync(python, ["-c", `
from pathlib import Path
import hashlib, sys, zipfile
root, version = Path(sys.argv[1]), sys.argv[2]

def bytes_for(p):
    return p.read_bytes()

# 各包期望清单（相对包根）
common = ['skin.mjs', 'src', 'skins', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'RELEASING.md', 'SECURITY.md', 'LICENSE', 'package.json', 'scripts/install.mjs', 'scripts/installed-cli.mjs']
mac_top = ['安装皮肤.command', '启动豆包工作.command', 'assets/AppIcon.icns']
win_top = ['安装皮肤.cmd', '安装皮肤.ps1', 'assets/AppIcon.ico']
skill_top = ['安装皮肤.command', '安装皮肤.cmd', '安装皮肤.ps1', '启动豆包工作.command', 'assets/AppIcon.icns', 'assets/AppIcon.ico']

def expected_map(roots):
    out = {}
    for name in roots:
        source = root / name
        if source.is_dir():
            for file in sorted(source.rglob('*')):
                if file.is_file():
                    out[file.relative_to(root).as_posix()] = bytes_for(file)
        else:
            out[name] = bytes_for(source)
    return out

mac_expected = expected_map(common + mac_top)
mac_expected['先看这里.txt'] = None
win_expected = expected_map(common + win_top)
win_expected['先看这里.txt'] = None
skill_expected = expected_map(common + skill_top)

checks = [
    (f'DoubaoWorkSkin-{version}-macos-scripts.zip', '豆包换肤/', mac_expected, ['.command']),
    (f'DoubaoWorkSkin-{version}-windows-scripts.zip', '豆包换肤/', win_expected, []),
    (f'doubao-work-skin-{version}-skill.zip', 'doubao-work-skin/assets/project/', skill_expected, []),
]
for filename, prefix, expected, exec_exts in checks:
    archive = root / 'dist' / filename
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert Path(str(archive) + '.sha256').read_text() == f'{checksum}  {filename}\\n', 'SHA-256 不一致'
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None, 'ZIP CRC 错误'
        files = {prefix + key: value for key, value in expected.items()}
        if 'skill' in filename:
            files['doubao-work-skin/SKILL.md'] = bytes_for(root / 'skills/doubao-work-skin/SKILL.md')
        assert len(z.namelist()) == len(files), f'{filename} 条目数不符: {len(z.namelist())} vs {len(files)}'
        assert set(z.namelist()) == set(files), f'{filename} 清单不一致'
        for name, content in files.items():
            if content is not None:
                assert z.read(name) == content, f'{filename} 与源码不一致: {name}'
            else:
                assert z.read(name), f'{filename} 空文件: {name}'
            if any(name.endswith(e) for e in exec_exts):
                assert (z.getinfo(name).external_attr >> 16) & 0o111, f'{filename} 缺少执行权限: {name}'
    print(f'校验通过: {filename}（SHA-256、CRC、完整清单、源码一致性、执行权限）')
`, ROOT, version], { stdio: "inherit" });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyRelease(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
