/**
 * Syncbay PaaS — Cloudflare Custom Domains & SSL API Client (M3/M5 Core)
 *
 * Integrates with Cloudflare for SaaS (Custom Hostnames API) to automate:
 * 1. Custom Hostname creation with automated SSL/TLS certificate provisioning.
 * 2. DNS ownership verification (CNAME target and TXT challenge verification).
 * 3. Real-time SSL certificate state machine monitoring (Pending -> Issuing -> Active).
 * 4. Simulation mode for offline/local/CI execution when API keys are absent — outside
 *    production only. With NODE_ENV=production and no API credentials every call that would
 *    simulate throws `CloudflareNotConfiguredError` instead (no simulated ACTIVE hostnames, no
 *    fake tunnel tokens). When the API IS configured, API failures are thrown, never simulated.
 */

import crypto from "node:crypto";

export interface CloudflareSslSettings {
  status: "active" | "pending_validation" | "initializing" | "pending_deployment" | "failed";
  method: "http" | "txt" | "cname";
  type: "dv";
  validation_records?: Array<{
    txt_name?: string;
    txt_value?: string;
    http_url?: string;
    http_body?: string;
  }>;
  certificate_authority?: string;
  expires_on?: string;
}

export interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  status: "active" | "pending" | "pending_validation" | "failed";
  ssl: CloudflareSslSettings;
  ownership_verification?: {
    type: "txt";
    name: string;
    value: string;
  };
  ownership_verification_http?: {
    http_url: string;
    http_body: string;
  };
  createdAt?: string;
  /** True only for records produced by the non-production simulation. */
  simulated?: boolean;
}

export class CloudflareNotConfiguredError extends Error {
  constructor(what: string) {
    super(`Cloudflare is not configured (${what}); refusing to simulate in production`);
    this.name = "CloudflareNotConfiguredError";
  }
}

function assertSimulationAllowed(what: string): void {
  if (process.env.NODE_ENV === "production") throw new CloudflareNotConfiguredError(what);
}

/** Cloudflare custom-hostname ids are UUIDs (simulated ones `ch_…`); hostnames contain dots. */
function looksLikeHostname(value: string): boolean {
  return value.includes(".");
}

export interface CreateCustomHostnameOptions {
  hostname: string;
  sslMethod?: "http" | "txt" | "cname";
  minTlsVersion?: "1.2" | "1.3";
}

export interface CustomHostnameVerificationResult {
  hostname: string;
  cfRecordId: string;
  status: "ACTIVE" | "PENDING" | "VERIFYING" | "FAILED";
  sslStatus: "ACTIVE" | "PENDING" | "ISSUING" | "FAILED";
  sslIssuer: string;
  cnameTarget: string;
  txtRecord: string;
  txtHost: string;
  verifiedAt?: string;
  errors?: string[];
  simulated?: boolean;
}

export interface CloudflareApiConfig {
  apiToken?: string;
  zoneId?: string;
  accountId?: string;
  cnameTarget?: string;
  baseUrl?: string;
}

export class CloudflareApiClient {
  private apiToken: string | undefined;
  private zoneId: string | undefined;
  private accountId: string | undefined;
  private cnameTarget: string;
  private baseUrl: string;

  // In-memory simulated storage for offline/testing mode
  private simulatedHostnames: Map<string, CloudflareCustomHostname> = new Map();

  constructor(config: CloudflareApiConfig = {}) {
    this.apiToken = config.apiToken || process.env.CLOUDFLARE_API_TOKEN;
    this.zoneId = config.zoneId || process.env.CLOUDFLARE_ZONE_ID;
    this.accountId = config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
    this.cnameTarget = config.cnameTarget || process.env.CLOUDFLARE_CNAME_TARGET || "cname.syncbay.app";
    this.baseUrl = config.baseUrl || "https://api.cloudflare.com/client/v4";
  }

  public get isLiveApiConfigured(): boolean {
    return Boolean(this.apiToken && this.zoneId);
  }

  /** Calls the Cloudflare API and returns `result`; throws with Cloudflare's error messages. */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      const detail = Array.isArray(json?.errors) && json.errors.length
        ? json.errors.map((e: any) => e?.message || String(e)).join("; ")
        : `HTTP ${res.status}`;
      throw new Error(`Cloudflare ${method} ${path.split("?")[0]} failed: ${detail}`);
    }
    return json?.result as T;
  }

  /**
   * Generates deterministic verification tokens for a domain
   */
  private generateTokens(hostname: string): { txtValue: string; txtName: string } {
    const cleanHost = hostname.toLowerCase().trim();
    const hash = crypto
      .createHash("sha256")
      .update(`syncbay-cf-saas:${cleanHost}:${process.env.NEXTAUTH_SECRET || "syncbay-saas-salt"}`)
      .digest("hex")
      .slice(0, 32);

    return {
      txtName: `_cf-custom-hostname.${cleanHost}`,
      txtValue: `syncbay-cf-verify=${hash}`,
    };
  }

  /**
   * Provisions a new Custom Hostname with auto-managed SSL certificate
   */
  public async createCustomHostname(
    options: CreateCustomHostnameOptions
  ): Promise<CloudflareCustomHostname> {
    const cleanHost = options.hostname.toLowerCase().trim();

    if (this.isLiveApiConfigured) {
      return this.api<CloudflareCustomHostname>("POST", `/zones/${this.zoneId}/custom_hostnames`, {
        hostname: cleanHost,
        ssl: {
          method: options.sslMethod || "txt",
          type: "dv",
          settings: {
            min_tls_version: options.minTlsVersion || "1.2",
            http2: "on",
          },
        },
      });
    }
    assertSimulationAllowed("createCustomHostname");

    // High-fidelity Simulated Response
    const tokens = this.generateTokens(cleanHost);
    const mockId = `ch_${crypto.randomBytes(12).toString("hex")}`;
    const isErrorCase = cleanHost.includes("fail") || cleanHost.includes("invalid");

    const record: CloudflareCustomHostname = {
      id: mockId,
      hostname: cleanHost,
      status: isErrorCase ? "failed" : "pending_validation",
      ssl: {
        status: isErrorCase ? "failed" : "pending_validation",
        method: options.sslMethod || "txt",
        type: "dv",
        certificate_authority: "google",
        validation_records: [
          {
            txt_name: tokens.txtName,
            txt_value: tokens.txtValue,
          },
        ],
      },
      ownership_verification: {
        type: "txt",
        name: tokens.txtName,
        value: tokens.txtValue,
      },
      createdAt: new Date().toISOString(),
      simulated: true,
    };

    this.simulatedHostnames.set(mockId, record);
    this.simulatedHostnames.set(cleanHost, record);
    return record;
  }

  /**
   * Retrieves status of a Custom Hostname
   */
  public async getCustomHostname(idOrHostname: string): Promise<CloudflareCustomHostname | null> {
    const cleanKey = idOrHostname.toLowerCase().trim();

    if (this.isLiveApiConfigured) {
      if (!looksLikeHostname(cleanKey)) {
        return this.api<CloudflareCustomHostname>("GET", `/zones/${this.zoneId}/custom_hostnames/${encodeURIComponent(cleanKey)}`);
      }
      const list = await this.api<CloudflareCustomHostname[]>(
        "GET",
        `/zones/${this.zoneId}/custom_hostnames?hostname=${encodeURIComponent(cleanKey)}`
      );
      return (Array.isArray(list) ? list[0] : null) || null;
    }
    if (process.env.NODE_ENV === "production") return null;

    return this.simulatedHostnames.get(cleanKey) || null;
  }

  /**
   * Verifies DNS propagation and SSL certificate activation
   */
  public async verifyCustomHostname(
    idOrHostname: string
  ): Promise<CustomHostnameVerificationResult> {
    const cleanKey = idOrHostname.toLowerCase().trim();
    const existing = await this.getCustomHostname(cleanKey);

    const hostname = existing?.hostname || cleanKey;
    const tokens = this.generateTokens(hostname);
    const isError = hostname.includes("fail") || hostname.includes("invalid");

    if (this.isLiveApiConfigured) {
      if (!existing) {
        return {
          hostname,
          cfRecordId: "",
          status: "PENDING",
          sslStatus: "PENDING",
          sslIssuer: "Cloudflare Managed CA",
          cnameTarget: this.cnameTarget,
          txtRecord: tokens.txtValue,
          txtHost: tokens.txtName,
          errors: ["Custom hostname is not registered with Cloudflare yet"],
        };
      }
      const rec = existing;
      const isActive = rec.status === "active" && rec.ssl?.status === "active";
      return {
        hostname: rec.hostname,
        cfRecordId: rec.id,
        status: isActive ? "ACTIVE" : rec.status === "failed" ? "FAILED" : "VERIFYING",
        sslStatus: rec.ssl?.status === "active" ? "ACTIVE" : rec.ssl?.status === "failed" ? "FAILED" : "ISSUING",
        sslIssuer: "Cloudflare Managed CA (Let's Encrypt / Google Trust Services)",
        cnameTarget: this.cnameTarget,
        txtRecord: rec.ownership_verification?.value || tokens.txtValue,
        txtHost: rec.ownership_verification?.name || tokens.txtName,
        verifiedAt: isActive ? new Date().toISOString() : undefined,
      };
    }
    assertSimulationAllowed("verifyCustomHostname");

    // High-fidelity Simulated Verification
    if (isError) {
      return {
        hostname,
        cfRecordId: existing?.id || `ch_err_${crypto.randomBytes(8).toString("hex")}`,
        status: "FAILED",
        sslStatus: "FAILED",
        sslIssuer: "Cloudflare Managed CA",
        cnameTarget: this.cnameTarget,
        txtRecord: tokens.txtValue,
        txtHost: tokens.txtName,
        errors: ["DNS CNAME record could not be resolved or TXT ownership verification timed out."],
        simulated: true,
      };
    }

    const updatedRecord: CloudflareCustomHostname = {
      id: existing?.id || `ch_${crypto.randomBytes(12).toString("hex")}`,
      hostname,
      status: "active",
      ssl: {
        status: "active",
        method: "txt",
        type: "dv",
        certificate_authority: "google",
      },
      createdAt: existing?.createdAt || new Date().toISOString(),
      simulated: true,
    };

    this.simulatedHostnames.set(updatedRecord.id, updatedRecord);
    this.simulatedHostnames.set(hostname, updatedRecord);

    return {
      hostname,
      cfRecordId: updatedRecord.id,
      status: "ACTIVE",
      sslStatus: "ACTIVE",
      sslIssuer: "Cloudflare Managed CA (Let's Encrypt / Google Trust Services)",
      cnameTarget: this.cnameTarget,
      txtRecord: tokens.txtValue,
      txtHost: tokens.txtName,
      verifiedAt: new Date().toISOString(),
      simulated: true,
    };
  }

  /**
   * Deletes a Custom Hostname
   */
  public async deleteCustomHostname(idOrHostname: string): Promise<boolean> {
    const cleanKey = idOrHostname.toLowerCase().trim();
    const existing = await this.getCustomHostname(cleanKey);
    const targetId = existing?.id || (!looksLikeHostname(cleanKey) ? cleanKey : null);

    if (this.isLiveApiConfigured) {
      if (!targetId) return false;
      await this.api("DELETE", `/zones/${this.zoneId}/custom_hostnames/${encodeURIComponent(targetId)}`);
      return true;
    }

    if (existing) {
      this.simulatedHostnames.delete(existing.id);
      this.simulatedHostnames.delete(existing.hostname);
    }
    this.simulatedHostnames.delete(cleanKey);
    return true;
  }

  /**
   * Replaces a remotely-managed tunnel's ingress configuration
   * (`PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`).
   * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; throws on API failure.
   */
  public async updateTunnelConfiguration(
    tunnelId: string,
    body: { config: { ingress: Array<Record<string, any>> } }
  ): Promise<{ tunnelId: string; version?: number }> {
    if (!this.apiToken || !this.accountId) {
      throw new Error("Cloudflare API token and account ID are required to update tunnel configuration");
    }
    const url = `${this.baseUrl}/accounts/${this.accountId}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      const detail = Array.isArray(json?.errors) && json.errors.length
        ? json.errors.map((e: any) => e?.message || String(e)).join("; ")
        : `HTTP ${res.status}`;
      throw new Error(`Cloudflare tunnel configuration update failed: ${detail}`);
    }
    return { tunnelId, version: json?.result?.version };
  }

  /**
   * Provisions or generates a scoped Cloudflare Tunnel token
   */
  public async provisionTunnelToken(
    tunnelName: string = "syncbay-edge-tunnel"
  ): Promise<{ tunnelId: string; token: string; simulated?: boolean }> {
    if (this.apiToken && this.accountId) {
      const created = await this.api<{ id: string }>("POST", `/accounts/${this.accountId}/cfd_tunnel`, {
        name: `${tunnelName}-${crypto.randomBytes(4).toString("hex")}`,
        config_src: "cloudflare",
        tunnel_secret: crypto.randomBytes(32).toString("base64"),
      });
      const token = await this.api<string>("GET", `/accounts/${this.accountId}/cfd_tunnel/${created.id}/token`);
      return { tunnelId: created.id, token };
    }
    assertSimulationAllowed("provisionTunnelToken");

    // Development-only placeholder: NOT a usable cloudflared token.
    const mockTunnelId = crypto.randomUUID();
    const mockPayload = {
      a: this.accountId || "syncbay-cf-account",
      t: mockTunnelId,
      s: crypto.randomBytes(32).toString("base64"),
    };
    const mockToken = Buffer.from(JSON.stringify(mockPayload)).toString("base64");

    return {
      tunnelId: mockTunnelId,
      token: mockToken,
      simulated: true,
    };
  }
}

export const cloudflareApiClient = new CloudflareApiClient();
