import { NextResponse } from "next/server";

const DEFAULT_MCP_CORE_URL = "http://127.0.0.1:8644";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      infraType?: unknown;
      triggerReason?: unknown;
    };
    const response = await fetch(
      new URL(
        "/dashboard/provision",
        process.env.MCP_CORE_URL ?? DEFAULT_MCP_CORE_URL,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      return NextResponse.json(
        { error: payload.error ?? "Infrastructure provisioning failed" },
        { status: response.status },
      );
    }
    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Infrastructure provisioning failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
