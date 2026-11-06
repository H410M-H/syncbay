/**
 * Syncbay PaaS — Domain & SSL Service (R5 Core)
 * Generates default subdomains, produces DNS verification records (CNAME & TXT), and
 * verifies them for real (node:dns/promises), plus the Cloudflare custom-hostname /
 * certificate status when Cloudflare for SaaS is configured.
 */

import crypto from "crypto";
import * as dns from "node:dns/promises";
import { db } from "@/lib/db";
import type { DomainStatus } from "@prisma/client";
import { cloudflareApiClient, type CloudflareApiClient } from "@/lib/tunnel/cloudflare-api";

export interface VerificationRecords {
  cnameTarget: string;
  txtRecord: string;
  txtHost: string;
  cnameHost: string;
}

/**
 * Normalizes strings into DNS-safe hostname slugs (RFC 1123)
 */
export function slugifyHostPart(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Validates domain name syntax
 */
export function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return domainRegex.test(hostname);
}

/**
 * Generates the default platform subdomain for a service in an environment.
 * Satisfies PROJECT.md contract:
 * `generateDefaultSubdomain(serviceName: string, envName: string): string`
 */
export function generateDefaultSubdomain(
  serviceName: string,
  envName: string,
  suffix?: string
): string {
  const serviceSlug = slugifyHostPart(serviceName) || "service";
  const envSlug = slugifyHostPart(envName) || "production";
  const base = `${serviceSlug}-${envSlug}`;
  const suffixPart = suffix ? `-${suffix}` : "";

  return `${base}${suffixPart}.syncbay.app`;
}

/** Hostname custom domains must CNAME to (CLOUDFLARE_CNAME_TARGET, default `cname.syncbay.app`). */
export function getCnameTarget(): string {
  return (process.env.CLOUDFLARE_CNAME_TARGET || "cname.syncbay.app").trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Generates CNAME and TXT verification records for custom domains.
 * Satisfies PROJECT.md contract:
 * `generateVerificationRecords(domain: string): { cnameTarget: string; txtRecord: string }`
 */
export function generateVerificationRecords(domain: string): VerificationRecords {
  const token = crypto
    .createHash("sha256")
    .update(`syncbay-verify:${domain}:${process.env.NEXTAUTH_SECRET || "salt"}`)
    .digest("hex")
    .slice(0, 32);

  const cleanDomain = domain.toLowerCase().trim();

  return {
    cnameTarget: getCnameTarget(),
    txtRecord: `syncbay-verification=${token}`,
    txtHost: `_syncbay-challenge.${cleanDomain}`,
    cnameHost: cleanDomain,
  };
}

// ─── DNS VERIFICATION ────────────────────────────────────────────────────────

/** The subset of `node:dns/promises` used here (injectable for tests). */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
}

/** Uses the process-wide resolver, so `dns.setServers()` applies. */
const systemResolver: DnsResolver = {
  resolveTxt: (h) => dns.resolveTxt(h),
  resolveCname: (h) => dns.resolveCname(h),
  resolve4: (h) => dns.resolve4(h),
};

export interface DomainDnsCheck {
  txt: { host: string; expected: string; found: string[]; ok: boolean };
  cname: { host: string; expected: string; found: string[]; ok: boolean; via: "cname" | "flattened" | null };
  errors: string[];
}

const MISSING_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

function describeDnsError(err: any, what: string): string {
  const code = err?.code || "EUNKNOWN";
  return MISSING_CODES.has(code) ? `No ${what} found` : `DNS lookup for ${what} failed (${code})`;
}

/**
 * Checks ownership (TXT `_syncbay-challenge.<host>` equals the expected token) and routing
 * (CNAME of `<host>` is the platform target; for apex domains with CNAME flattening, the
 * host's A records match the target's).
 */
export async function checkDomainDns(
  hostname: string,
  expectedTxt: string,
  resolver: DnsResolver = systemResolver
): Promise<DomainDnsCheck> {
  const host = normalizeName(hostname);
  const target = getCnameTarget();
  const txtHost = `_syncbay-challenge.${host}`;
  const errors: string[] = [];

  let txtFound: string[] = [];
  try {
    txtFound = (await resolver.resolveTxt(txtHost)).map((chunks) => chunks.join(""));
  } catch (err) {
    errors.push(`${describeDnsError(err, `TXT record at ${txtHost}`)}`);
  }
  const txtOk = txtFound.some((v) => v.trim() === expectedTxt);
  if (txtFound.length && !txtOk) errors.push(`TXT record at ${txtHost} does not contain "${expectedTxt}"`);

  let cnameFound: string[] = [];
  let via: DomainDnsCheck["cname"]["via"] = null;
  let cnameErr: any = null;
  try {
    cnameFound = (await resolver.resolveCname(host)).map(normalizeName);
    if (cnameFound.includes(target)) via = "cname";
  } catch (err) {
    cnameErr = err;
  }
  if (!via && (!cnameFound.length || cnameErr)) {
    // Apex / flattened CNAME: compare A records with the target's.
    try {
      const [hostA, targetA] = await Promise.all([resolver.resolve4(host), resolver.resolve4(target)]);
      if (hostA.length && targetA.length && hostA.some((ip) => targetA.includes(ip))) via = "flattened";
    } catch {}
  }
  if (!via) {
    errors.push(
      cnameFound.length
        ? `CNAME of ${host} points to ${cnameFound.join(", ")}, expected ${target}`
        : cnameErr
        ? `${describeDnsError(cnameErr, `CNAME record for ${host}`)} (expected ${target})`
        : `CNAME record for ${host} must point to ${target}`
    );
  }

  return {
    txt: { host: txtHost, expected: expectedTxt, found: txtFound, ok: txtOk },
    cname: { host, expected: target, found: cnameFound, ok: Boolean(via), via },
    errors,
  };
}

export interface DomainVerificationResult {
  status: DomainStatus;
  dns: DomainDnsCheck | null;
  cloudflare: { configured: boolean; status?: string; sslStatus?: string; recordId?: string };
  errors: string[];
}

type CloudflareHostnames = Pick<CloudflareApiClient, "isLiveApiConfigured" | "getCustomHostname" | "createCustomHostname">;

/**
 * Verifies a domain for real and persists the outcome:
 * - generated `*.syncbay.app` hosts are covered by the platform wildcard → ACTIVE;
 * - custom hosts need the TXT challenge AND the CNAME (or flattened A) record. Until both
 *   resolve the domain stays VERIFYING with the DNS errors listed;
 * - with Cloudflare for SaaS configured (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID) the custom
 *   hostname must also be `active` with an active certificate; a Cloudflare `failed` → FAILED;
 * - without Cloudflare, proven DNS is enough → ACTIVE.
 * There is no simulated outcome in any environment.
 */
export async function verifyDomainDetailed(
  domainId: string,
  deps: { resolver?: DnsResolver; cloudflare?: CloudflareHostnames; client?: Pick<typeof db, "domain"> } = {}
): Promise<DomainVerificationResult> {
  const client = deps.client || db;
  const domain = await client.domain.findUnique({ where: { id: domainId } });
  if (!domain) {
    throw new Error(`Domain not found: ${domainId}`);
  }
  const cf = deps.cloudflare || cloudflareApiClient;

  if (domain.isGenerated) {
    if (domain.status !== "ACTIVE") {
      await client.domain.update({ where: { id: domainId }, data: { status: "ACTIVE", verifiedAt: new Date() } });
    }
    return { status: "ACTIVE", dns: null, cloudflare: { configured: cf.isLiveApiConfigured }, errors: [] };
  }

  if (!isValidHostname(domain.hostname)) {
    await client.domain.update({ where: { id: domainId }, data: { status: "FAILED" } });
    return { status: "FAILED", dns: null, cloudflare: { configured: cf.isLiveApiConfigured }, errors: ["Invalid hostname"] };
  }

  await client.domain.update({ where: { id: domainId }, data: { status: "VERIFYING" } });

  const expectedTxt = domain.verificationTxt || generateVerificationRecords(domain.hostname).txtRecord;
  const dnsCheck = await checkDomainDns(domain.hostname, expectedTxt, deps.resolver);
  const errors = [...dnsCheck.errors];
  const cloudflare: DomainVerificationResult["cloudflare"] = { configured: cf.isLiveApiConfigured };
  let status: DomainStatus = "VERIFYING";

  // Cloudflare custom hostnames need "SSL for SaaS" on the zone. Without it (or when explicitly
  // disabled) DNS ownership verification alone decides, and TLS must come from elsewhere.
  const customHostnamesEnabled =
    cf.isLiveApiConfigured && (process.env.CLOUDFLARE_CUSTOM_HOSTNAMES || "").toLowerCase() !== "off";

  if (dnsCheck.txt.ok && dnsCheck.cname.ok) {
    if (!customHostnamesEnabled) {
      status = "ACTIVE";
    } else {
      try {
        let record = await cf.getCustomHostname(domain.cfRecordId || domain.hostname);
        if (!record) record = await cf.createCustomHostname({ hostname: domain.hostname });
        cloudflare.status = record.status;
        cloudflare.sslStatus = record.ssl?.status;
        cloudflare.recordId = record.id;
        if (record.id && record.id !== domain.cfRecordId) {
          await client.domain.update({ where: { id: domainId }, data: { cfRecordId: record.id } });
        }
        if (record.status === "active" && record.ssl?.status === "active") {
          status = "ACTIVE";
        } else if (record.status === "failed" || record.ssl?.status === "failed") {
          status = "FAILED";
          errors.push(`Cloudflare custom hostname ${record.status} (certificate ${record.ssl?.status || "unknown"})`);
        } else {
          errors.push(`Cloudflare is still validating the hostname (status ${record.status}, certificate ${record.ssl?.status || "pending"})`);
        }
      } catch (err: any) {
        if (/no quota has been allocated/i.test(String(err?.message))) {
          // The zone has no SSL for SaaS entitlement: custom hostnames can never be created, so
          // fall back to DNS-only verification instead of leaving the domain VERIFYING forever.
          status = "ACTIVE";
          cloudflare.status = "unavailable";
          errors.push(
            "Cloudflare custom hostnames are not enabled for this zone (SSL for SaaS); verified by DNS only. Set CLOUDFLARE_CUSTOM_HOSTNAMES=off to skip this check."
          );
        } else {
          errors.push(`Cloudflare custom hostname check failed: ${err.message}`);
        }
      }
    }
  }

  await client.domain.update({
    where: { id: domainId },
    data: { status, verifiedAt: status === "ACTIVE" ? new Date() : null },
  });
  return { status, dns: dnsCheck, cloudflare, errors };
}

/**
 * Verifies domain DNS and provisions SSL certificate.
 * Satisfies PROJECT.md contract:
 * `verifyDomain(domainId: string): Promise<DomainStatus>`
 */
export async function verifyDomain(domainId: string): Promise<DomainStatus> {
  return (await verifyDomainDetailed(domainId)).status;
}

export const domainService = {
  generateDefaultSubdomain,
  generateVerificationRecords,
  verifyDomain,
  isValidHostname,
  slugifyHostPart,
};
