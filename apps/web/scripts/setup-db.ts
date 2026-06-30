import { config } from "dotenv";
import { resolve } from "node:path";
import { runAllMigrations } from "../lib/db/migrate";

config({ path: resolve(__dirname, "../.env.local") });

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is missing. Add it to apps/web/.env.local from Supabase dashboard.",
    );
    process.exit(1);
  }

  await runAllMigrations(databaseUrl);
  console.log("Migrations are up to date.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
