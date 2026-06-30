import { Suspense } from "react";
import SimDashboard from "@/components/SimDashboard";

// The dashboard is fully client/live (reads search params, polls live state),
// so opt out of static prerendering instead of bailing out at build time.
export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <SimDashboard />
    </Suspense>
  );
}
