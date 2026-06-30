import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ensureDriverConnectedAccount,
  getStripeConnectServer,
} from "./connect";

interface DriverRow {
  id: string;
  name: string;
  stripe_payout_account_id: string | null;
}

type AdminClient = SupabaseClient;

export interface ProvisionedDriverSummary {
  accountApiVersion: "v1" | "v2";
  driverId: string;
  driverName: string;
  stripePayoutAccountId: string;
  transfersCapability: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
  requirementsDisabledReason: string | null;
}

let provisioningSupabaseAdmin: AdminClient | null = null;

function getProvisioningSupabaseAdmin(): AdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for Stripe Connect provisioning.",
    );
  }

  if (!provisioningSupabaseAdmin) {
    provisioningSupabaseAdmin = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            cache: "no-store",
          }),
      },
    });
  }

  return provisioningSupabaseAdmin;
}

export async function provisionStripeConnectDrivers(): Promise<ProvisionedDriverSummary[]> {
  const stripe = getStripeConnectServer();
  const supabase = getProvisioningSupabaseAdmin();
  const result = await supabase
    .from("drivers")
    .select("id, name, stripe_payout_account_id")
    .order("id", { ascending: true });

  if (result.error) {
    throw new Error(`Failed to load drivers for Stripe payout account provisioning: ${result.error.message}`);
  }

  const drivers = (result.data ?? []) as DriverRow[];
  if (drivers.length === 0) {
    throw new Error("No drivers found in Postgres. Seed the database before provisioning Stripe payout accounts.");
  }

  const summaries: ProvisionedDriverSummary[] = [];

  for (const driver of drivers) {
    const account = await ensureDriverConnectedAccount(stripe, {
      driverId: driver.id,
      driverName: driver.name,
      existingAccountId: driver.stripe_payout_account_id,
    });
    const updateResult = await supabase
      .from("drivers")
      .update({ stripe_payout_account_id: account.stripePayoutAccountId })
      .eq("id", driver.id);

    if (updateResult.error) {
      throw new Error(
        `Failed to persist Stripe payout account for driver ${driver.id}: ${updateResult.error.message}`,
      );
    }

    summaries.push({
      accountApiVersion: account.accountApiVersion,
      driverId: driver.id,
      driverName: driver.name,
      stripePayoutAccountId: account.stripePayoutAccountId,
      transfersCapability: account.transfersCapability,
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      detailsSubmitted: account.detailsSubmitted,
      requirementsCurrentlyDue: account.requirementsCurrentlyDue,
      requirementsDisabledReason: account.requirementsDisabledReason,
    });
  }

  return summaries;
}
