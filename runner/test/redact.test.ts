import { test } from "node:test";
import assert from "node:assert";
import { redactSecrets } from "../src/redact.ts";

test("redactSecrets: strips URL credentials and GitHub tokens", () => {
  const clone = 'git clone -b master -- "https://x-access-token:gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/acme/app.git" "/w"';
  const out = redactSecrets(clone);
  assert.ok(!out.includes("gho_"), out);
  assert.ok(out.includes("https://***@github.com/acme/app.git"));
  assert.strictEqual(redactSecrets("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 leaked"), "token *** leaked");
  assert.strictEqual(redactSecrets("postgres://user:pw@db:5432/x"), "postgres://***@db:5432/x");
  assert.strictEqual(redactSecrets("plain line, no secrets"), "plain line, no secrets");
});
