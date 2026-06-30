import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

let migrationPromise: Promise<void> | null = null;
let migrationsComplete = false;

interface MigrationFile {
  name: string;
  path: string;
}

function migrationPaths(): string[] {
  const migrationsDir = resolve(process.cwd(), "../../supabase/migrations");
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => resolve(migrationsDir, entry));
}

function migrationFiles(): MigrationFile[] {
  return migrationPaths().map((path) => ({
    name: path.split(/[/\\]/).at(-1) ?? path,
    path,
  }));
}

async function ensureSchemaMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrationNames(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  return new Set(result.rows.map((row) => row.name));
}

async function markMigrationApplied(
  client: pg.Client,
  name: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO schema_migrations (name)
      VALUES ($1)
      ON CONFLICT (name) DO NOTHING
    `,
    [name],
  );
}

async function tableExists(
  client: pg.Client,
  tableName: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
    `,
    [tableName],
  );
  return result.rows[0]?.exists ?? false;
}

async function columnExists(
  client: pg.Client,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
      ) AS exists
    `,
    [tableName, columnName],
  );
  return result.rows[0]?.exists ?? false;
}

async function columnIsNullable(
  client: pg.Client,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await client.query<{ is_nullable: "YES" | "NO" }>(
    `
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    `,
    [tableName, columnName],
  );
  return result.rows[0]?.is_nullable === "YES";
}

async function isMigrationAlreadyReflected(
  client: pg.Client,
  migrationName: string,
): Promise<boolean> {
  switch (migrationName) {
    case "0001_init.sql":
      return (
        await Promise.all([
          "pickup_hubs",
          "customer_locations",
          "drivers",
          "vehicles",
          "orders",
          "incidents",
          "agent_decisions",
          "ledger",
          "simulation_events",
          "customer_notifications",
          "policy_evaluations",
        ].map((tableName) => tableExists(client, tableName)))
      ).every(Boolean);
    case "0002_stripe_orders.sql":
      return (
        (await columnExists(client, "orders", "stripe_checkout_session_id")) &&
        (await columnExists(client, "orders", "stripe_payment_intent_id")) &&
        (await columnExists(client, "orders", "stripe_event_id")) &&
        (await columnExists(client, "orders", "created_at"))
      );
    case "0002_vehicle_routing_plan.sql":
      return (
        (await columnExists(client, "vehicles", "routing_provider")) &&
        (await columnExists(client, "vehicles", "routing_plan"))
      );
    case "0003_stripe_connect_payouts.sql":
      return (
        (await columnExists(client, "ledger", "stripe_reference")) &&
        (
          (await columnExists(client, "drivers", "stripe_connected_account_id")) ||
          (await columnExists(client, "drivers", "stripe_payout_account_id"))
        )
      );
    case "0004_payment_declined_incidents.sql":
      return columnIsNullable(client, "incidents", "vehicle_id");
    case "0005_rename_driver_payout_account_column.sql":
      return (
        (await columnExists(client, "drivers", "stripe_payout_account_id")) &&
        !(await columnExists(client, "drivers", "stripe_connected_account_id"))
      );
    default:
      return false;
  }
}

export async function runAllMigrations(databaseUrl: string): Promise<void> {
  if (!databaseUrl.trim()) {
    return;
  }

  const client = new pg.Client({
    connectionString: databaseUrl.trim(),
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await ensureSchemaMigrationsTable(client);
    const appliedMigrationNames = await getAppliedMigrationNames(client);

    for (const migration of migrationFiles()) {
      if (appliedMigrationNames.has(migration.name)) {
        continue;
      }

      if (await isMigrationAlreadyReflected(client, migration.name)) {
        await markMigrationApplied(client, migration.name);
        appliedMigrationNames.add(migration.name);
        continue;
      }

      const sql = readFileSync(migration.path, "utf8");
      await client.query(sql);
      await markMigrationApplied(client, migration.name);
      appliedMigrationNames.add(migration.name);
    }
  } finally {
    await client.end();
  }
}

export async function runMigrationIfNeeded(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return;
  }

  if (migrationsComplete) {
    return;
  }

  if (!migrationPromise) {
    migrationPromise = runAllMigrations(databaseUrl)
      .then(() => {
        migrationsComplete = true;
      })
      .finally(() => {
        migrationPromise = null;
      });
  }

  await migrationPromise;
}
