# Cursor Prompts

One file per implementation-plan phase, written to be pasted into Cursor directly. Cursor has filesystem access and built this codebase; Claude (Snehal's planning assistant) writes these prompts after reading the existing architecture, and Snehal reviews before sending.

**Rule: don't start the next phase's prompt until the current phase's gate (in `docs/IMPLEMENTATION_PLAN.md`) has passed.** Prompts are written one or two phases ahead at a time, not all eleven up front — later phases depend on what actually got built, not just what was planned.

## Ready now
- [`PHASE_2_PROMPT.md`](./PHASE_2_PROMPT.md) — City map + deterministic simulator. No API keys needed.
- [`PHASE_3_PROMPT.md`](./PHASE_3_PROMPT.md) — Postgres + Redis persistence. Needs Supabase + Redis credentials (already collected).
- [`PHASE_4_PROMPT.md`](./PHASE_4_PROMPT.md) — Stripe Checkout + webhooks. Needs Stripe keys (already collected) + Stripe CLI for local webhook testing.

## Not written yet — ask once Phase 4 is confirmed
- Phase 5: Routing service (Mock + cuOpt providers)
- Phase 6: MCP server (16 tools)
- Phase 7: Nemotron via Nous Portal
- Phase 8: NemoClaw runtime
- Phase 9: Stripe Connect payouts
- Phase 10: Stripe Projects operation
- Phase 11: Demo polish

## Before running any prompt
1. Confirm the previous phase's gate passed (see `docs/IMPLEMENTATION_PLAN.md`).
2. Confirm required `.env` values for that phase are filled in `apps/web/.env.local` (never the committed `.env.example`).
3. Read the prompt yourself first — each one restates the relevant hard rules (no recursive deletes near `.git`/config, no secrets in client-bundled code, stop for approval on destructive ops) so Cursor sees them fresh each time, but skim for anything that doesn't match what's actually in the repo by the time you run it.
