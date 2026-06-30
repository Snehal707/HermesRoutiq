import { config } from "dotenv";
import { resolve } from "node:path";
import { provisionStripeConnectDrivers } from "../lib/stripe/provision.js";

async function main(): Promise<void> {
  config({ path: resolve(__dirname, "../.env.local") });
  const summaries = await provisionStripeConnectDrivers();
  console.log(JSON.stringify({
    provisionedDrivers: summaries,
  }, null, 2));
}

main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    error.message.includes("signed up for Connect")
  ) {
    console.error(
      "Stripe Connect is not enabled on the current Stripe account. Enable Connect in the Stripe dashboard, then rerun this provisioning script.",
    );
    process.exit(1);
  }

  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
