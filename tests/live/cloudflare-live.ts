// Live, read-mostly checks of Syncbay's Cloudflare client against the real API.
// Needs CLOUDFLARE_API_TOKEN (the agent proxy can inject it), CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ZONE_ID.
import { CloudflareApiClient } from "../../src/lib/tunnel/cloudflare-api";
async function main() {
  const c = new CloudflareApiClient();
  console.log("live API configured:", c.isLiveApiConfigured);
  try {
    const r = await c.getCustomHostname("e2e-probe.example.com");
    console.log("custom hostname lookup ok:", r ? r.status : "none");
  } catch (e: any) {
    console.log("custom hostname lookup error:", e.message);
  }
}
main().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
