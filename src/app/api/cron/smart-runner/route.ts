import { NextRequest, NextResponse } from "next/server";
import { executeSmartCrons } from "@/lib/crons/smart-crons";
import { isAuthorizedCronRequest } from "@/lib/crons/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleCronExecution(req);
}

export async function POST(req: NextRequest) {
  return handleCronExecution(req);
}

async function handleCronExecution(req: NextRequest) {
  // Bearer CRON_SECRET only (timing-safe); no x-vercel-cron trust, no default secret.
  if (!isAuthorizedCronRequest(req.headers)) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing CRON_SECRET authorization token" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const categoryParam = searchParams.get("category")?.toUpperCase();
  const validCategory =
    categoryParam === "ACQUISITION" ||
    categoryParam === "MAINTENANCE" ||
    categoryParam === "SECURITY"
      ? (categoryParam as any)
      : "ALL";

  try {
    const report = await executeSmartCrons(validCategory);
    return NextResponse.json({
      status: "SUCCESS",
      triggeredBy: req.headers.get("user-agent") || "syncbay-cron-system",
      ...report,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        status: "FAILED",
        error: err.message || "Failed to execute smart crons",
      },
      { status: 500 }
    );
  }
}
