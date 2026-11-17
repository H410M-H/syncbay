/**
 * Volume path guard + read-only volume routes (runner/src/volume-files.ts, services.ts).
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  VOLUME_LIST_LIMIT,
  VOLUME_READ_LIMIT,
  VolumeAccessError,
  VolumeBrowser,
  isWithinRoot,
  listDirectoryDirect,
  normalizeVolumeRelPath,
  readFileDirect,
} from "../src/volume-files.ts";

test("normalizeVolumeRelPath: refuses traversal, absolute paths, NUL and backslashes", () => {
  const refused = ["..", "../etc/passwd", "a/../../b", "a/..", "/etc/passwd", "//etc", "C:\\x", "c:/x", "..\\..\\x", "a\\b", "~/x", "a\0b", "x".repeat(5000)];
  for (const p of refused) {
    const r = normalizeVolumeRelPath(p);
    assert.strictEqual(r.ok, false, `expected refusal for ${JSON.stringify(p.slice(0, 40))}`);
  }
  assert.strictEqual(normalizeVolumeRelPath(42).ok, false);
  const accepted: Array<[unknown, string]> = [
    [undefined, ""], [null, ""], ["", ""], [".", ""], ["./", ""], ["a", "a"], ["a/b/", "a/b"], ["./a//b/./c", "a/b/c"], ["..a/b..", "..a/b.."], ["...", "..."],
  ];
  for (const [input, rel] of accepted) {
    const r = normalizeVolumeRelPath(input);
    assert.deepStrictEqual(r, { ok: true, rel }, `input ${JSON.stringify(input)}`);
  }
});

test("isWithinRoot: prefix siblings are outside", () => {
  assert.strictEqual(isWithinRoot("/data/vol", "/data/vol"), true);
  assert.strictEqual(isWithinRoot("/data/vol", "/data/vol/a/b"), true);
  assert.strictEqual(isWithinRoot("/data/vol/", "/data/vol/a"), true);
  assert.strictEqual(isWithinRoot("/data/vol", "/data/vol2/a"), false);
  assert.strictEqual(isWithinRoot("/data/vol", "/data"), false);
});

function makeVolume(): { base: string; root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-vol-test-"));
  const root = path.join(base, "volumes", "volabc");
  const outside = path.join(base, "secret");
  fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "token.txt"), "TOP-SECRET");
  fs.writeFileSync(path.join(root, "hello.txt"), "hello volume\n");
  fs.writeFileSync(path.join(root, "sub", "deep", "n.json"), '{"n":1}');
  fs.writeFileSync(path.join(root, "big.log"), "x".repeat(VOLUME_READ_LIMIT + 1000));
  fs.symlinkSync(outside, path.join(root, "escape-dir"));
  fs.symlinkSync(path.join(outside, "token.txt"), path.join(root, "escape-file"));
  fs.symlinkSync("hello.txt", path.join(root, "inner-link"));
  fs.symlinkSync("../../../secret/token.txt", path.join(root, "sub", "rel-escape"));
  return { base, root, outside };
}

function expectAccessError(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof VolumeAccessError, `expected VolumeAccessError, got ${err}`);
    assert.strictEqual(err.status, status, err.message);
    return;
  }
  assert.fail(`expected a ${status} refusal`);
}

test("direct access: lists without following symlinks, reads inside, refuses escapes", () => {
  const { base, root } = makeVolume();
  try {
    const listing = listDirectoryDirect(root, "");
    const byName = new Map(listing.entries.map((e) => [e.name, e]));
    assert.strictEqual(byName.get("sub")?.type, "dir");
    assert.strictEqual(byName.get("hello.txt")?.type, "file");
    assert.strictEqual(byName.get("hello.txt")?.size, 13);
    assert.strictEqual(byName.get("escape-dir")?.type, "symlink");
    assert.strictEqual(byName.get("escape-file")?.type, "symlink");
    assert.strictEqual(listing.entries[0].type, "dir", "directories sort first");
    assert.ok(byName.get("hello.txt")?.mtime);

    assert.deepStrictEqual(listDirectoryDirect(root, "sub/deep").entries.map((e) => e.name), ["n.json"]);
    const hello = readFileDirect(root, "hello.txt");
    assert.strictEqual(Buffer.from(hello.contentBase64, "base64").toString(), "hello volume\n");
    assert.strictEqual(hello.truncated, false);
    assert.strictEqual(readFileDirect(root, "inner-link").size, 13, "a symlink inside the volume is fine");

    const big = readFileDirect(root, "big.log");
    assert.strictEqual(big.bytesReturned, VOLUME_READ_LIMIT);
    assert.strictEqual(big.truncated, true);
    assert.strictEqual(big.size, VOLUME_READ_LIMIT + 1000);

    expectAccessError(() => listDirectoryDirect(root, "escape-dir"), 403);
    expectAccessError(() => readFileDirect(root, "escape-file"), 403);
    expectAccessError(() => readFileDirect(root, "sub/rel-escape"), 403);
    expectAccessError(() => readFileDirect(root, "escape-dir/token.txt"), 403);
    expectAccessError(() => readFileDirect(root, "missing.txt"), 404);
    expectAccessError(() => listDirectoryDirect(root, "hello.txt"), 409);
    expectAccessError(() => readFileDirect(root, "sub"), 409);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("direct access: listings stop at the entry limit", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-vol-many-"));
  try {
    for (let i = 0; i < VOLUME_LIST_LIMIT + 5; i++) fs.writeFileSync(path.join(base, `f${i}`), "");
    const listing = listDirectoryDirect(base, "");
    assert.strictEqual(listing.entries.length, VOLUME_LIST_LIMIT);
    assert.strictEqual(listing.truncated, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("GET /api/volumes/:id/*: signed (query included), single-use, guarded", async () => {
  const { RunnerDaemon } = await import("../src/index.ts");
  const { RunnerServices } = await import("../src/services.ts");
  const { PortManager } = await import("../src/port-manager.ts");
  const { BuildPipeline, MockPipelineExecutor } = await import("../src/pipeline.ts");
  const { base } = makeVolume();
  const secret = "volume-test-key";
  const pm = new PortManager({ rangeStart: 36000, rangeEnd: 36050 });
  const daemon = new RunnerDaemon({
    port: 0,
    webhookSecret: secret,
    portManager: pm,
    pipeline: new BuildPipeline({ executor: new MockPipelineExecutor(), portManager: pm }),
    services: new RunnerServices({
      portManager: pm,
      mode: "mock",
      volumes: new VolumeBrowser({ nativeBaseDir: path.join(base, "volumes"), access: "direct" }),
    }),
  });
  const port = await daemon.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sign = (pathname: string, payload: string) => {
    const ts = Date.now().toString();
    const nonce = randomBytes(16).toString("hex");
    const sig = createHmac("sha256", secret).update(`${ts}.${nonce}.GET.${pathname}.${payload}`).digest("hex");
    return { "X-Syncbay-Signature": `sha256=${sig}`, "X-Syncbay-Timestamp": ts, "X-Syncbay-Nonce": nonce };
  };
  const get = (pathname: string, query = "") => fetch(`${baseUrl}${pathname}${query}`, { headers: sign(pathname, `${pathname}${query}`) });
  try {
    assert.strictEqual((await fetch(`${baseUrl}/api/volumes/volabc/stat`)).status, 401, "unsigned");

    const stat = await get("/api/volumes/volabc/stat");
    assert.strictEqual(stat.status, 200);
    const statBody = await stat.json();
    assert.strictEqual(statBody.backend, "native");
    assert.ok(statBody.entries >= 5);

    const files = await (await get("/api/volumes/volabc/files", "?path=sub")).json();
    assert.deepStrictEqual(files.entries.map((e: { name: string }) => e.name), ["deep", "rel-escape"]);

    const file = await (await get("/api/volumes/volabc/file", "?path=hello.txt")).json();
    assert.strictEqual(Buffer.from(file.contentBase64, "base64").toString(), "hello volume\n");

    // The query string is part of the signature: signing `?path=hello.txt` and sending another path fails.
    const headers = sign("/api/volumes/volabc/file", "/api/volumes/volabc/file?path=hello.txt");
    assert.strictEqual((await fetch(`${baseUrl}/api/volumes/volabc/file?path=escape-file`, { headers })).status, 401);

    // Replay of an accepted request is refused.
    const replayHeaders = sign("/api/volumes/volabc/stat", "/api/volumes/volabc/stat");
    assert.strictEqual((await fetch(`${baseUrl}/api/volumes/volabc/stat`, { headers: replayHeaders })).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}/api/volumes/volabc/stat`, { headers: replayHeaders })).status, 401);

    for (const [query, status] of [
      ["?path=..%2F..%2Fsecret%2Ftoken.txt", 400],
      ["?path=%2Fetc%2Fpasswd", 400],
      ["?path=sub%2F..%2F..%2Fsecret", 400],
      ["?path=escape-file", 403],
      ["?path=escape-dir%2Ftoken.txt", 403],
      ["?path=nope.txt", 404],
    ] as const) {
      const res = await get("/api/volumes/volabc/file", query);
      assert.strictEqual(res.status, status, `file${query}`);
      const body = await res.json();
      assert.ok(!JSON.stringify(body).includes("TOP-SECRET"));
    }
    assert.strictEqual((await get("/api/volumes/volabc/files", "?path=escape-dir")).status, 403);
    const missing = await get("/api/volumes/novolume/stat");
    assert.strictEqual(missing.status, 404);
    assert.strictEqual((await missing.json()).code, "VOLUME_NOT_FOUND");
    assert.strictEqual((await get("/api/volumes/bad%20id/stat")).status, 400);
    // Unknown volume subroutes answer 404 WITH a code (a 404 without one means "runner too old").
    for (const p of ["/api/volumes/volabc/nope", "/api/volumes/volabc", "/api/volumes", "/api/volumes/volabc/files/extra"]) {
      const res = await get(p);
      assert.strictEqual(res.status, 404, p);
      assert.strictEqual((await res.json()).code, "UNKNOWN_ROUTE", p);
    }
  } finally {
    await daemon.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
