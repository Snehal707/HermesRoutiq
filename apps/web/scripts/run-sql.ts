import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

config({ path: resolve(__dirname, "../.env.local") });

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Usage: tsx scripts/run-sql.ts <path-to-sql-file>");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is missing from apps/web/.env.local. Add it from Supabase dashboard (Settings → Database → Connection string URI).",
  );
  process.exit(1);
}

const sqlPath = resolve(__dirname, fileArg);
const sql = readFileSync(sqlPath, "utf8");

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log(`Executed SQL file: ${sqlPath}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
