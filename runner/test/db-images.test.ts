/**
 * Managed-database image choice and option validation (runner/src/services.ts): pgvector,
 * Valkey, recovery of the provider from a container image. Pure, no Docker.
 */

import assert from "node:assert";
import test from "node:test";
import { databaseImageFor, providerFromImage, validateDatabaseOptions } from "../src/services.ts";

test("databaseImageFor: pgvector for extensions [vector], valkey for engine valkey, defaults otherwise", () => {
  const saved = { pg: process.env.RUNNER_PGVECTOR_IMAGE, vk: process.env.RUNNER_VALKEY_IMAGE };
  delete process.env.RUNNER_PGVECTOR_IMAGE;
  delete process.env.RUNNER_VALKEY_IMAGE;
  try {
    assert.strictEqual(databaseImageFor({ provider: "POSTGRES" }), "postgres:16-alpine");
    assert.strictEqual(databaseImageFor({ provider: "POSTGRES", extensions: [] }), "postgres:16-alpine");
    assert.strictEqual(databaseImageFor({ provider: "POSTGRES", extensions: ["vector"] }), "pgvector/pgvector:pg16");
    assert.strictEqual(databaseImageFor({ provider: "REDIS" }), "redis:7-alpine");
    assert.strictEqual(databaseImageFor({ provider: "REDIS", engine: "valkey" }), "valkey/valkey:8-alpine");
    assert.strictEqual(databaseImageFor({ provider: "MYSQL" }), "mysql:8");
    process.env.RUNNER_PGVECTOR_IMAGE = "registry.example/pgvector:pg16";
    assert.strictEqual(databaseImageFor({ provider: "POSTGRES", extensions: ["vector"] }), "registry.example/pgvector:pg16");
  } finally {
    if (saved.pg === undefined) delete process.env.RUNNER_PGVECTOR_IMAGE;
    else process.env.RUNNER_PGVECTOR_IMAGE = saved.pg;
    if (saved.vk !== undefined) process.env.RUNNER_VALKEY_IMAGE = saved.vk;
  }
});

test("providerFromImage: recovery reads pgvector as POSTGRES and valkey as REDIS", () => {
  assert.strictEqual(providerFromImage("pgvector/pgvector:pg16"), "POSTGRES");
  assert.strictEqual(providerFromImage("postgres:16-alpine"), "POSTGRES");
  assert.strictEqual(providerFromImage("valkey/valkey:8-alpine"), "REDIS");
  assert.strictEqual(providerFromImage("redis:7-alpine"), "REDIS");
  assert.strictEqual(providerFromImage("mysql:8"), "MYSQL");
});

test("validateDatabaseOptions: only vector, only on POSTGRES; valkey only on REDIS", () => {
  assert.strictEqual(validateDatabaseOptions({ provider: "POSTGRES", extensions: ["vector"] }), null);
  assert.strictEqual(validateDatabaseOptions({ provider: "REDIS", engine: "valkey" }), null);
  assert.match(validateDatabaseOptions({ provider: "POSTGRES", extensions: ["postgis"] })!, /Unsupported extension/);
  assert.match(validateDatabaseOptions({ provider: "REDIS", extensions: ["vector"] })!, /only supported for POSTGRES/);
  assert.match(validateDatabaseOptions({ provider: "POSTGRES", engine: "valkey" })!, /requires provider REDIS/);
  assert.match(validateDatabaseOptions({ provider: "REDIS", engine: "keydb" })!, /Unsupported engine/);
});
