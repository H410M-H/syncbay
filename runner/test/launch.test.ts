import assert from "node:assert";
import test from "node:test";
import { Semaphore, containerEnv, nodeRangeAllows, parseListeningPorts, pickNodeVersion, shq, tailText } from "../src/launch.ts";
import { parsePortRange, rewriteDatabaseUrls } from "../src/db-network.ts";

test("shq: one shell argument, whatever it contains", () => {
  assert.strictEqual(shq("npm run start"), "'npm run start'");
  assert.strictEqual(shq("it's $(rm -rf /) `x`"), "'it'\\''s $(rm -rf /) `x`'");
});

test("tailText: keeps the end of the output", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const tail = tailText(text, 3);
  assert.strictEqual(tail, "line 97\nline 98\nline 99");
  assert.ok(tailText("x".repeat(10_000), 40, 100).length <= 101);
});

test("containerEnv: values stay in the process environment, flags carry names only", () => {
  const built = containerEnv({ API_KEY: "s3cret value", "bad key": "x", PORT: "9999" }, { PORT: "3000" }, { HOST: "0.0.0.0" });
  assert.deepStrictEqual(built.env, { HOST: "0.0.0.0", API_KEY: "s3cret value", PORT: "3000" });
  assert.deepStrictEqual(built.dockerFlags, ["-e HOST", "-e API_KEY", "-e PORT"]);
  assert.ok(!built.dockerFlags.join(" ").includes("s3cret"));
  assert.deepStrictEqual(built.skipped, ["bad key"]);
  assert.strictEqual(containerEnv({ HOST: "127.0.0.1" }, {}, { HOST: "0.0.0.0" }).env.HOST, "127.0.0.1", "a user value beats a default");
});

test("parseListeningPorts: listening sockets from /proc/net/tcp, loopback flagged", () => {
  const proc = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0",
    "   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0 100 0 0 10 0",
    "   2: 0A000002:C350 0A000001:01BB 01 00000000:00000000 00:00000000 00000000     0        0 3 1 0 100 0 0 10 0",
    "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0 100 0 0 10 0",
    "   1: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0 100 0 0 10 0",
  ].join("\n");
  assert.deepStrictEqual(parseListeningPorts(proc), [
    { port: 3000, loopbackOnly: false },
    { port: 5173, loopbackOnly: true },
    { port: 8080, loopbackOnly: false },
    { port: 9000, loopbackOnly: true },
  ]);
  assert.deepStrictEqual(parseListeningPorts("ok"), []);
});

test("pickNodeVersion: a current Node unless the project pins another major", () => {
  const pkg = (node?: string) => ({ engines: node ? { node } : undefined });
  assert.strictEqual(pickNodeVersion({ packageJson: pkg() }), "22");
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(">=18") }), "22", "an open range gets a current version");
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(">=20.9.0") }), "22");
  assert.strictEqual(pickNodeVersion({ packageJson: pkg("18.x || 20.x || 22.x") }), "22");
  assert.strictEqual(pickNodeVersion({ packageJson: pkg("18.x") }), null, "a pinned major is left to Nixpacks");
  assert.strictEqual(pickNodeVersion({ packageJson: pkg("^20.9.0") }), null);
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(">=18 <21") }), null);
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(), hasNvmrc: true }), null);
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(), nodeVersionFile: "v20.11.1\n" }), "20");
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(), userEnv: { NIXPACKS_NODE_VERSION: "18" } }), null);
  assert.strictEqual(pickNodeVersion({ packageJson: pkg(), fallback: "20" }), "20");
  assert.strictEqual(pickNodeVersion({ packageJson: null }), null, "not a Node project");
  assert.strictEqual(nodeRangeAllows("18 - 22", 22), true);
  assert.strictEqual(nodeRangeAllows("*", 22), true);
});

test("Semaphore: at most `limit` tasks at once, in arrival order", async () => {
  const gate = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const waits: number[] = [];
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      gate.run(
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(n);
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
        },
        (ahead) => waits.push(ahead)
      )
    )
  );
  assert.strictEqual(peak, 2);
  assert.deepStrictEqual(order, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(waits, [1, 2, 3]);
});

test("rewriteDatabaseUrls: only URLs of databases on this runner change", () => {
  const targets = [{ publicHost: "47.237.1.136", port: 10001, internalHost: "172.17.0.1" }];
  const { env, rewritten } = rewriteDatabaseUrls(
    {
      DATABASE_URL: "postgresql://postgres:p%40ss@47.237.1.136:10001/main",
      REDIS_URL: "redis://default:x@47.237.1.136:10002",
      OTHER_DB: "postgresql://u:p@47.237.1.136:100012/main",
      SITE: "https://47.237.1.136/",
      PLAIN: "47.237.1.136:10001",
    },
    targets
  );
  assert.strictEqual(env.DATABASE_URL, "postgresql://postgres:p%40ss@172.17.0.1:10001/main");
  assert.strictEqual(env.REDIS_URL, "redis://default:x@47.237.1.136:10002", "another port is not ours");
  assert.strictEqual(env.OTHER_DB, "postgresql://u:p@47.237.1.136:100012/main", "a longer port number is not a match");
  assert.strictEqual(env.SITE, "https://47.237.1.136/");
  assert.strictEqual(env.PLAIN, "47.237.1.136:10001", "not a URL");
  assert.deepStrictEqual(rewritten, ["DATABASE_URL"]);
  assert.deepStrictEqual(rewriteDatabaseUrls({ A: "redis://h:1" }, [{ publicHost: "h", port: 1, internalHost: "h" }]).rewritten, []);
});

test("parsePortRange: RUNNER_DB_PORT_RANGE", () => {
  assert.deepStrictEqual(parsePortRange("54320-54399"), { start: 54320, end: 54399 });
  assert.strictEqual(parsePortRange(""), null);
  assert.strictEqual(parsePortRange("80-90"), null);
  assert.strictEqual(parsePortRange("5000-4000"), null);
});
