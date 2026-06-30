import Stripe from "stripe";

export interface DriverConnectedAccountInput {
  driverId: string;
  driverName: string;
  email?: string | null;
}

export interface EnsuredDriverConnectedAccount {
  accountApiVersion: "v1" | "v2";
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  requirementsCurrentlyDue: string[];
  requirementsDisabledReason: string | null;
  stripePayoutAccountId: string;
  transfersCapability: string | null;
}

export interface DriverPayoutTransferInput {
  amountCents: number;
  payoutAccountId: string;
  currency?: string;
  description?: string;
  appIdempotencyKey: string;
  stripeIdempotencyKey: string;
  incidentId?: string | null;
  driverId: string;
}

interface StripeConnectClient {
  accounts: {
    create: (...args: any[]) => Promise<Stripe.Account>;
    retrieve: (...args: any[]) => Promise<Stripe.Account>;
    update: (...args: any[]) => Promise<Stripe.Account>;
  };
  transfers: {
    create: (...args: any[]) => Promise<Stripe.Transfer>;
    list: (...args: any[]) => Promise<Stripe.ApiList<Stripe.Transfer>>;
  };
  v2: {
    core: {
      accounts: {
        create: (...args: any[]) => Promise<Stripe.Response<Stripe.V2.Core.Account>>;
        retrieve: (...args: any[]) => Promise<Stripe.Response<Stripe.V2.Core.Account>>;
        update: (...args: any[]) => Promise<Stripe.Response<Stripe.V2.Core.Account>>;
      };
    };
  };
}

function asStripeConnectClient(stripe: unknown): StripeConnectClient {
  return stripe as StripeConnectClient;
}

function splitDriverName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? "Demo";
  const lastName = parts.slice(1).join(" ") || "Driver";
  return { firstName, lastName };
}

function buildDriverEmail(input: DriverConnectedAccountInput): string {
  if (input.email && input.email.trim().length > 0) {
    return input.email.trim().toLowerCase();
  }

  return `${input.driverId}@drivers.hermes-routiq.test`;
}

function buildBusinessProfileUrl(driverId: string): string {
  return `https://furever.dev/drivers/${driverId}`;
}

const V2_ACCOUNT_INCLUDE: Stripe.V2.Core.AccountRetrieveParams.Include[] = [
  "configuration.recipient",
  "defaults",
  "identity",
  "requirements",
];

function v2TransferCapabilityStatus(
  account: Stripe.V2.Core.Account,
): string | null {
  return account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status ?? null;
}

function v2PayoutCapabilityStatus(
  account: Stripe.V2.Core.Account,
): string | null {
  return account.configuration?.recipient?.capabilities?.stripe_balance?.payouts?.status ?? null;
}

function v2RequirementCodes(
  account: Stripe.V2.Core.Account,
): string[] {
  return (account.requirements?.entries ?? []).flatMap((entry) => (
    entry.requested_reasons?.map((reason) => reason.code) ?? []
  ));
}

function v2RequirementDisabledReason(
  account: Stripe.V2.Core.Account,
): string | null {
  const details =
    account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status_details ?? [];
  if (details.length === 0) {
    return null;
  }

  return details
    .map((detail) => detail.code)
    .filter(Boolean)
    .join(", ");
}

function toEnsuredV2Account(
  account: Stripe.V2.Core.Account,
): EnsuredDriverConnectedAccount {
  const transfersCapability = v2TransferCapabilityStatus(account);
  const payoutsCapability = v2PayoutCapabilityStatus(account);

  return {
    accountApiVersion: "v2",
    chargesEnabled: false,
    detailsSubmitted: transfersCapability === "active",
    payoutsEnabled: payoutsCapability === "active",
    requirementsCurrentlyDue: v2RequirementCodes(account),
    requirementsDisabledReason: v2RequirementDisabledReason(account),
    stripePayoutAccountId: account.id,
    transfersCapability,
  };
}

function toEnsuredV1Account(
  account: Stripe.Account,
): EnsuredDriverConnectedAccount {
  return {
    accountApiVersion: "v1",
    chargesEnabled: account.charges_enabled,
    detailsSubmitted: account.details_submitted,
    payoutsEnabled: account.payouts_enabled,
    requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    requirementsDisabledReason: account.requirements?.disabled_reason ?? null,
    stripePayoutAccountId: account.id,
    transfersCapability: account.capabilities?.transfers ?? null,
  };
}

async function retrieveV2ConnectedAccount(
  stripe: unknown,
  accountId: string,
): Promise<Stripe.Response<Stripe.V2.Core.Account> | null> {
  const client = asStripeConnectClient(stripe);

  try {
    return await client.v2.core.accounts.retrieve(accountId, {
      include: V2_ACCOUNT_INCLUDE,
    });
  } catch {
    return null;
  }
}

function buildV2DriverAccountCreateParams(
  input: DriverConnectedAccountInput,
): Stripe.V2.Core.AccountCreateParams {
  const email = buildDriverEmail(input);
  const { firstName, lastName } = splitDriverName(input.driverName);

  return {
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: {
              requested: true,
            },
          },
        },
      },
    },
    contact_email: email,
    contact_phone: "4155551212",
    dashboard: "none",
    defaults: {
      currency: "usd",
      locales: ["en-US"],
      profile: {
        business_url: buildBusinessProfileUrl(input.driverId),
        doing_business_as: input.driverName,
        product_description: "Last-mile delivery driver in HermesRoutiq demo sandbox",
      },
      responsibilities: {
        fees_collector: "application",
        losses_collector: "application",
      },
    },
    display_name: input.driverName,
    identity: {
      country: "US",
      entity_type: "individual",
      individual: {
        address: {
          city: "San Francisco",
          country: "US",
          line1: "510 Townsend St",
          postal_code: "94103",
          state: "CA",
        },
        date_of_birth: {
          day: 1,
          month: 1,
          year: 1990,
        },
        email,
        given_name: firstName,
        phone: "4155551212",
        surname: lastName,
      },
    },
    include: V2_ACCOUNT_INCLUDE,
    metadata: {
      driverId: input.driverId,
      driverName: input.driverName,
      driverFirstName: firstName,
      driverLastName: lastName,
      demo: "hermes-routiq",
      provisionedWith: "stripe-connect-v2",
    },
  };
}

let stripeConnectClient: Stripe | null = null;

export function getStripeConnectServer(secretKey = process.env.STRIPE_CONNECT_SECRET_KEY): Stripe {
  if (!secretKey || secretKey.trim().length === 0) {
    throw new Error("Missing STRIPE_CONNECT_SECRET_KEY for Stripe Connect operations.");
  }

  if (!stripeConnectClient) {
    stripeConnectClient = new Stripe(secretKey);
  }

  return stripeConnectClient;
}

export async function createDriverConnectedAccount(
  stripe: unknown,
  input: DriverConnectedAccountInput,
): Promise<Stripe.Response<Stripe.V2.Core.Account>> {
  const client = asStripeConnectClient(stripe);

  return client.v2.core.accounts.create(buildV2DriverAccountCreateParams(input));
}

export async function ensureDriverConnectedAccountTransfersCapability(
  stripe: unknown,
  accountId: string,
  driverId: string,
): Promise<Stripe.Response<Stripe.V2.Core.Account> | Stripe.Account> {
  const client = asStripeConnectClient(stripe);
  const v2Account = await retrieveV2ConnectedAccount(stripe, accountId);

  if (v2Account) {
    return client.v2.core.accounts.update(accountId, {
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: {
                requested: true,
              },
            },
          },
        },
      },
      defaults: {
        profile: {
          business_url: buildBusinessProfileUrl(driverId),
        },
      },
      include: V2_ACCOUNT_INCLUDE,
    });
  }

  return client.accounts.update(accountId, {
    business_profile: {
      url: buildBusinessProfileUrl(driverId),
    },
    capabilities: {
      transfers: {
        requested: true,
      },
    },
  });
}

export async function ensureDriverConnectedAccount(
  stripe: unknown,
  input: DriverConnectedAccountInput & { existingAccountId?: string | null },
): Promise<EnsuredDriverConnectedAccount> {
  const client = asStripeConnectClient(stripe);
  const existingAccountId = input.existingAccountId?.trim() || null;

  if (existingAccountId) {
    const v2Account = await retrieveV2ConnectedAccount(stripe, existingAccountId);
    if (v2Account) {
      if (v2TransferCapabilityStatus(v2Account) === "active") {
        return toEnsuredV2Account(v2Account);
      }

      const repairedV2Account = await ensureDriverConnectedAccountTransfersCapability(
        stripe,
        existingAccountId,
        input.driverId,
      );
      if ("object" in repairedV2Account && repairedV2Account.object === "v2.core.account") {
        return toEnsuredV2Account(repairedV2Account);
      }
    }

    try {
      const legacyAccount = await client.accounts.retrieve(existingAccountId);
      if (legacyAccount.capabilities?.transfers === "active") {
        return toEnsuredV1Account(legacyAccount);
      }

      const repairedLegacyAccount = await ensureDriverConnectedAccountTransfersCapability(
        stripe,
        existingAccountId,
        input.driverId,
      );
      if ("object" in repairedLegacyAccount && repairedLegacyAccount.object !== "v2.core.account") {
        return toEnsuredV1Account(repairedLegacyAccount);
      }
    } catch {
      // Fall through to new account creation if the stored id is stale.
    }
  }

  const createdAccount = await createDriverConnectedAccount(stripe, input);
  return toEnsuredV2Account(createdAccount);
}

export async function createDriverPayoutTransfer(
  stripe: unknown,
  input: DriverPayoutTransferInput,
): Promise<Stripe.Transfer> {
  const client = asStripeConnectClient(stripe);

  return client.transfers.create({
    amount: input.amountCents,
    currency: input.currency ?? "usd",
    destination: input.payoutAccountId,
    description:
      input.description ??
      `HermesRoutiq incident payout for driver ${input.driverId}`,
    metadata: {
      driverId: input.driverId,
      incidentId: input.incidentId ?? "",
      idempotencyKey: input.appIdempotencyKey,
      payoutType: "incident_recovery",
    },
    transfer_group: input.incidentId ?? `driver-payout:${input.driverId}`,
  }, {
    idempotencyKey: input.stripeIdempotencyKey,
  });
}

export async function findDriverPayoutTransferByAppIdempotencyKey(
  stripe: unknown,
  appIdempotencyKey: string,
): Promise<Stripe.Transfer | null> {
  const client = asStripeConnectClient(stripe);
  const transfers = await client.transfers.list({ limit: 100 });

  return transfers.data.find(
    (transfer) => transfer.metadata?.idempotencyKey === appIdempotencyKey,
  ) ?? null;
}
