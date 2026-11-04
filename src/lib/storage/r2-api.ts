/**
 * Minimal Cloudflare R2 bucket-management client
 * (`/accounts/{account_id}/r2/buckets`, Bearer CLOUDFLARE_API_TOKEN).
 */

export class R2ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[] = []
  ) {
    super(message);
    this.name = "R2ApiError";
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

export interface R2BucketInfo {
  name: string;
  creation_date?: string;
  location?: string;
}

export class R2ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: { accountId: string; apiToken: string; baseUrl?: string; fetchImpl?: typeof fetch }
  ) {
    this.baseUrl = (opts.baseUrl || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/accounts/${encodeURIComponent(this.opts.accountId)}/r2/buckets${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: CfEnvelope<T> | null = null;
    try {
      json = (await res.json()) as CfEnvelope<T>;
    } catch {
      json = null;
    }
    if (!res.ok || !json?.success) {
      const errors = json?.errors ?? [];
      const msg = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new R2ApiError(`Cloudflare R2 API ${method} ${path || "/"} failed: ${msg}`, res.status, errors.map((e) => e.code));
    }
    return json.result as T;
  }

  createBucket(name: string, locationHint?: string): Promise<R2BucketInfo> {
    return this.call<R2BucketInfo>("POST", "", { name, ...(locationHint ? { locationHint } : {}) });
  }

  getBucket(name: string): Promise<R2BucketInfo> {
    return this.call<R2BucketInfo>("GET", `/${encodeURIComponent(name)}`);
  }

  async deleteBucket(name: string): Promise<void> {
    await this.call<unknown>("DELETE", `/${encodeURIComponent(name)}`);
  }
}
