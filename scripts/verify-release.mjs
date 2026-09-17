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
  execFileSync("python3", ["-c", `
from pathlib import Path
import hashlib, sys, zipfile
root, version = Path(sys.argv[1]), sys.argv[2]
expected = {}
for name in ['安装皮肤.command', '启动豆包工作.command', 'skin.mjs', 'src', 'skins', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'RELEASING.md', 'SECURITY.md', 'LICENSE', 'package.json', 'scripts/install.mjs', 'scripts/installed-cli.mjs']:
    source = root / name
    for file in sorted(source.rglob('*')) if source.is_dir() else [source]:
        if file.is_file():
            expected[file.relative_to(root).as_posix()] = file.read_bytes()
expected['先看这里.txt'] = None
for filename, prefix, skill in [
    (f'DoubaoWorkSkin-{version}-macos-scripts.zip', '豆包工作皮肤/', False),
    (f'doubao-work-skin-{version}-skill.zip', 'doubao-work-skin/assets/project/', True),
]:
    archive = root / 'dist' / filename
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert Path(str(archive) + '.sha256').read_text() == f'{checksum}  {filename}\\n', 'SHA-256 不一致'
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None, 'ZIP CRC 错误'
        files = {prefix + key: value for key, value in expected.items()}
        if skill:
            files['doubao-work-skin/SKILL.md'] = (root / 'skills/doubao-work-skin/SKILL.md').read_bytes()
        assert len(z.namelist()) == len(files) and set(z.namelist()) == set(files), '发布文件清单不一致'
        for name, content in files.items():
            if content is not None:
                assert z.read(name) == content, f'发布文件与源码不一致: {name}'
            else:
                assert z.read(name), f'空文件: {name}'
            if name.endswith('.command'):
                assert (z.getinfo(name).external_attr >> 16) & 0o111, f'缺少执行权限: {name}'
    print(f'校验通过: {filename}（SHA-256、CRC、完整文件清单、源码一致性、执行权限）')
`, ROOT, version], { stdio: "inherit" });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyRelease(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
