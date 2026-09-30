import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findOwnedWatchProcesses, inspectWatchProcess } from "../src/runtime.mjs";

const projectRoot = path.resolve("watch-regression-fixture");
const injectorPath = path.join(projectRoot, "src", "injector.mjs");
const watchArgs = `${path.join("src", "injector.mjs")} --watch --port 9342 --skin "${path.join(projectRoot, "skins", "default")}"`;

function processInfo(pid) {
  if (pid === 1) return { command: `node ${watchArgs}`, cwd: projectRoot };
  if (pid === 2) return { command: `node.exe ${watchArgs}`, cwd: projectRoot };
  if (pid === 3) return { command: `/bin/sh -c node ${watchArgs}`, cwd: projectRoot };
  if (pid === 4) return { command: `not-node ${watchArgs}`, cwd: projectRoot };
  throw new Error("missing");
}

test("直接使用裸 node 或 node.exe 启动的项目 watch 可被识别", async () => {
  for (const pid of [1, 2]) {
    const entry = await inspectWatchProcess(pid, {
      inspectProcess: processInfo,
      projectRoot,
      injectorPath,
    });
    assert.equal(entry.pid, pid);
    assert.equal(entry.port, 9342);
  }
});

test("裸 node 支持不会误认 shell 包装或近似可执行文件名", async () => {
  for (const pid of [3, 4]) {
    assert.equal(await inspectWatchProcess(pid, {
      inspectProcess: processInfo,
      projectRoot,
      injectorPath,
    }), null);
  }
  const owned = await findOwnedWatchProcesses({
    listProcesses: async () => [1, 2, 3, 4].map((pid) => ({ pid, command: "injector.mjs --watch" })),
    inspectProcess: processInfo,
    projectRoot,
    injectorPath,
  });
  assert.deepEqual(owned.map((entry) => entry.pid), [1, 2]);
});
