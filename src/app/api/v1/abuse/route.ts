import { NextRequest, NextResponse } from "next/server";
import { abuseReportSchema, rateLimited, submitAbuseReport } from "@/lib/admin/abuse-intake";

export const dynamic = "force-dynamic";

/** Public abuse report form endpoint (no login). Answers 202 with a reference id. */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many reports from this address. Try again later or email abuse@syncbay.app." }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = abuseReportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the form", issues: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  try {
    const result = await submitAbuseReport(parsed.data, ip === "unknown" ? null : ip);
    return NextResponse.json({ accepted: true, reference: result.id ?? null }, { status: 202 });
  } catch (err) {
    console.error("[abuse] report intake failed:", (err as Error)?.message);
    return NextResponse.json({ error: "Could not record the report. Email abuse@syncbay.app." }, { status: 500 });
  }
}
