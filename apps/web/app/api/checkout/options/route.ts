import { NextResponse } from "next/server";
import { ensureInitialized } from "@/lib/sim/persistence";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await ensureInitialized();

    const { data, error } = await getSupabaseAdmin()
      .from("pickup_hubs")
      .select("id,name,lat,lng")
      // South first so it's the default selection: the suggested drop below is a
      // South-hub route whose path has a clean one-block detour around the
      // congestion zone (verified against OSRM), which makes the congestion demo
      // show a real reroute.
      .order("name", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({
      pickupHubs: (data ?? []).map((hub) => ({
        id: hub.id,
        name: hub.name,
        lat: hub.lat,
        lng: hub.lng,
      })),
      suggestedDestination: {
        customerName: "Folsom Street Drop",
        destinationLat: 37.789,
        destinationLng: -122.4,
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to load checkout options";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
