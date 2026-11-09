import { test } from "node:test";
import assert from "node:assert";
import { withBuildToolHint, RUNNER_UPDATE_COMMAND, ensureBuildx } from "../src/build-hints.ts";

test("withBuildToolHint: adds the runner update command when buildx is missing", () => {
  const raw = "Nixpacks build failed: ERROR: BuildKit is enabled but the buildx component is missing or broken.";
  const out = withBuildToolHint(raw);
  assert.ok(out.startsWith(raw));
  assert.ok(out.includes(RUNNER_UPDATE_COMMAND));
});

test("withBuildToolHint: leaves unrelated build errors untouched", () => {
  const raw = "Docker build failed: npm ERR! missing script: build";
  assert.strictEqual(withBuildToolHint(raw), raw);
});

test("ensureBuildx: reports the real toolchain of this host without throwing", async () => {
  const prev = process.env.RUNNER_AUTO_INSTALL_BUILDX;
  process.env.RUNNER_AUTO_INSTALL_BUILDX = "false"; // never download in unit tests
  try {
    const lines: string[] = [];
    const status = await ensureBuildx((l) => lines.push(l));
    assert.strictEqual(typeof status.docker, "boolean");
    assert.ok(status.buildx === null || /buildx/.test(status.buildx));
  } finally {
    if (prev === undefined) delete process.env.RUNNER_AUTO_INSTALL_BUILDX;
    else process.env.RUNNER_AUTO_INSTALL_BUILDX = prev;
  }
});
