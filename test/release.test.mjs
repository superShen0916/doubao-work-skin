import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { validateReleaseTag } from "../scripts/verify-release.mjs";

test("发版拒绝版本不一致、预发布 tag 和异常 tag", () => {
  assert.doesNotThrow(() => validateReleaseTag("v2.2.2", "2.2.2"));
  for (const tag of ["v2.2.1", "2.2.2", "v2.2.2-rc.1", "v02.2.2", "v2.2.2/../notes", "main"]) {
    assert.throws(() => validateReleaseTag(tag, "2.2.2"), /必须与 package.json/);
  }
});

test("Release 中使用 Bash 读取 GitHub tag，发布包在 macOS 构建并验收", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Validate release tag\s+shell: bash\s+run: node scripts\/verify-release\.mjs --tag-only "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /publish:\s+needs: check\s+runs-on: macos-latest/);
  assert.match(workflow, /name: Verify release packages\s+shell: bash\s+run: node scripts\/verify-release\.mjs --tag "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /shasum -a 256 -c \.\/\*\.zip\.sha256/);
  const packageWorkflow = await fs.readFile(new URL("../.github/workflows/script-package.yml", import.meta.url), "utf8");
  assert.match(packageWorkflow, /package:\s+runs-on: macos-latest/);
  assert.match(packageWorkflow, /- run: npm run verify:release/);
});
