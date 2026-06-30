import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "@/lib/dashboard/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await getDashboardSnapshot());
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to load dashboard data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
