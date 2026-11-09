import { test } from "node:test";
import assert from "node:assert";
import { withBuildToolHint, RUNNER_UPDATE_COMMAND } from "../src/build-hints.ts";

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
