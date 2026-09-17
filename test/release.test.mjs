import test from "node:test";
import assert from "node:assert/strict";
import { validateReleaseTag } from "../scripts/verify-release.mjs";

test("发版拒绝版本不一致、预发布 tag 和异常 tag", () => {
  assert.doesNotThrow(() => validateReleaseTag("v2.2.2", "2.2.2"));
  for (const tag of ["v2.2.1", "2.2.2", "v2.2.2-rc.1", "v02.2.2", "v2.2.2/../notes", "main"]) {
    assert.throws(() => validateReleaseTag(tag, "2.2.2"), /必须与 package.json/);
  }
});
