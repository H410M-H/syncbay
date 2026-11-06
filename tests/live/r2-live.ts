import { R2ApiClient } from "../../src/lib/storage/r2-api";
const acct = process.argv[2];
const c = new R2ApiClient({ accountId: acct, apiToken: "proxy-injected" });
const name = `syncbay-e2e-${Date.now()}`;
async function main() {
const created = await c.createBucket(name);
console.log("PASS create", created.name);
const got = await c.getBucket(name);
console.log(got.name === name ? "PASS get" : "FAIL get", got.creation_date ?? "");
await c.deleteBucket(name);
try { await c.getBucket(name); console.log("FAIL still exists"); } catch (e: any) { console.log("PASS deleted (get now fails:", e.status, ")"); }
}
main().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
