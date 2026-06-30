import { NextResponse } from "next/server";
import type { SimulatorSnapshot } from "@hermes-routiq/shared";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const baseUrl = process.env.SIMULATOR_BASE_URL ?? process.env.NEXT_PUBLIC_SIMULATION_BACKEND;

  if (!baseUrl) {
    return NextResponse.json(
      { error: "Simulator backend is not configured" },
      { status: 503 },
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    let response: Response;
    let payload: (SimulatorSnapshot & { error?: string }) | null = null;

    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}/snapshot`, {
        cache: "no-store",
        signal: controller.signal,
      });
      payload = (await response.json()) as SimulatorSnapshot & {
        error?: string;
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to load simulator snapshot");
    }

    return NextResponse.json(payload);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? "Timed out loading simulator snapshot"
          : error.message
        : "Failed to load simulator snapshot";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
