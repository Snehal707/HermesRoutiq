import "server-only";

import pg from "pg";

type PostgresClient = pg.PoolClient;

let pool: pg.Pool | null = null;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for transactional fleet routing updates.",
    );
  }

  return databaseUrl;
}

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getDatabaseUrl(),
      ssl: { rejectUnauthorized: false },
    });
  }

  return pool;
}

export async function withPostgresTransaction<T>(
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type { PostgresClient };
