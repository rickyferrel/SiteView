import { query } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// GET /api/health — is the app talking to its database? When it isn't, report
// the driver's actual error so an incident is diagnosable from any browser
// (no CloudWatch digging). `backend` distinguishes the two known prod failure
// modes: "pglite" here means the runtime never got its PG* vars (write-env
// regression); "postgres" plus an auth error means the RDS password the build
// baked in no longer works. No hosts or credentials in the response.
export async function GET() {
  const backend = process.env.DATABASE_URL || process.env.PGHOST ? "postgres" : "pglite";
  const started = Date.now();
  try {
    await query("select 1");
    return NextResponse.json(
      { ok: true, backend, ms: Date.now() - started },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    const err = e as Error & { code?: string };
    return NextResponse.json(
      { ok: false, backend, ms: Date.now() - started, error: err.message, code: err.code },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
