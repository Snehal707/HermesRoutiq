# Cursor Prompt — Phase 3: Postgres + Redis

Paste this after Phase 2 is confirmed working. Do not run this prompt until Phase 2's map and simulator are visibly working.

---

You are working in the `hermes-routiq` repo. Read `docs/ARCHITECTURE.md` and `docs/SECURITY_POLICY.md` before starting — pay attention to the rule that `SUPABASE_SERVICE_ROLE_KEY` must never reach client/browser code.

## Goal
Persist simulation state to Supabase Postgres so it survives a browser refresh, and move live/fast-changing state (driver positions, tick state) into Redis. No Hermes, no MCP, no Stripe yet.

## Prerequisite
A `.env.local` file must exist in `apps/web/` (and equivalent in any new service) with real values for: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `REDIS_URL`. If any are missing, stop and tell the user which ones, rather than guessing or hardcoding placeholders into committed files.

## Files to create
- `supabase/migrations/0001_init.sql` — tables exactly as specified in `docs/ARCHITECTURE.md` section "Core Database Tables": `drivers`, `vehicles`, `orders`, `incidents`, `agent_decisions`, `ledger`, `simulation_events`, `customer_notifications`, `policy_evaluations`. Use the field lists from the architecture doc precisely — do not invent extra fields, do not drop required ones.
- `supabase/seed.sql` — seed data matching the deterministic world from Phase 2's `lib/sim/world.ts` (8 drivers, 8 vehicles, 2 hubs as a `pickup_hub` concept if not already a table — check architecture doc first, hubs may need to be folded into an existing table or a new lightweight one; if ambiguous, ask before inventing a new table not in the doc).
- `apps/web/lib/supabase/server.ts` — server-only Supabase client using the service role key. Add a comment at the top: `// SERVER ONLY — never import this file in a Client Component or anything bundled to the browser.`
- `apps/web/lib/supabase/client.ts` — browser-safe Supabase client using only the anon/publishable key.
- `apps/web/lib/redis.ts` — Redis client (ioredis or @upstash/redis, your choice based on what's simplest given the connection string format) reading `REDIS_URL`. Server-only.
- Wire the Phase 2 simulator so that: (a) each driver/vehicle position tick writes to Redis (fast, ephemeral), (b) order/incident/decision-level events write to Postgres (durable), (c) on page load, the app hydrates from Postgres + Redis instead of recreating the world from scratch in memory.

## Behavior requirements
1. Start the simulation, let it run a few seconds, refresh the browser — driver positions and any active incident should resume from where they were, not reset.
2. Triggering a breakdown creates a row in `incidents`.
3. No `SUPABASE_SERVICE_ROLE_KEY` usage appears in any file under a path that would be bundled client-side (no `"use client"` file imports `server.ts`).
4. Confirm `.env.local` is gitignored and was not staged in any commit.

## Explicit non-goals for this phase
No MCP server, no Hermes, no Stripe, no cuOpt calls. Routing stays on the Phase 2 precomputed/mock routes.

## Process
1. State file changes in small batches before writing.
2. Run the migration against the real Supabase project and confirm tables exist via the Supabase dashboard or a query, don't just assume the SQL ran.
3. Lint + typecheck after each batch.
4. Stop after this phase's gate (refresh-survives-reload) passes. Do not start Phase 4 (Stripe) without explicit go-ahead.

## Hard rules
- Never run a recursive delete near `.git` or any config file without asking first.
- Never commit `.env` or `.env.local`.
- Never let client-bundled code touch the service role key or `DATABASE_URL`.
- Stop and ask before any destructive or irreversible operation (including `DROP TABLE`, resetting the Supabase project, or overwriting existing migration files).
