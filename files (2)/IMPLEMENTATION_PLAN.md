# HermesRoutiq — Implementation Plan

Eleven phases. Each phase has an exit gate; you do not start the next phase until the gate passes. Lint + typecheck + unit tests run at every milestone; integration tests where applicable. Mocks are fine during development. The **final demo** must use the real sponsor surfaces (Hermes, Nemotron 3 Ultra, NemoClaw, cuOpt, Stripe Checkout/webhooks/Connect/Projects) — no silent mock substitution.

---

## Phase 0 — Verify sponsor surfaces (do this before docs are "done")
Network is needed for these; confirm each and record the real values in `.env`:
- **Nemotron via Nous Portal (primary)** — `hermes model` → Nous Portal → `nvidia/nemotron-3-ultra`, billed against existing Nous API credits. **OpenRouter (fallback)** — same model family, slug `nvidia/nemotron-3-ultra-550b-a55b`, switch is config-only. Smoke-test the primary with one chat turn before wiring MCP; confirm the fallback switch also works so a mid-demo provider hiccup is a one-line recovery.
- Stripe Skills install line works: `npx skills add https://docs.stripe.com --skill stripe-projects -g -y`.
- cuOpt reachable via chosen `CUOPT_API_URL` (managed endpoint or local NIM).
- NemoClaw `nemohermes` quickstart runs end to end against Hermes, with the active provider key isolated as a Hermes-only credential.
**Gate:** a one-call smoke test against each surface returns 200/valid.

## Phase 1 — Documentation (current phase)
`ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `SECURITY_POLICY.md`, `DEMO_SCRIPT.md`, repo tree, env vars, risks, first milestone defined. **No application code before these are complete.**
**Gate:** docs reviewed; repo tree scaffolded empty.

## Phase 2 — Map + deterministic simulator (FIRST CODE MILESTONE)
Next.js app renders the 2.5D city; 8 drivers spawn and move along predefined seeded routes; pickup hubs + customer destinations render; sim controls (start/pause/reset/speed) work; breakdown button stops a vehicle and turns it red. No DB, no Hermes, no Stripe yet — in-memory seeded state only.
**Gate:** same seed ⇒ identical movement; breakdown visibly fires.

## Phase 3 — Postgres + Redis
Supabase migrations for all tables; simulator writes through to Postgres; live state in Redis; browser refresh recovers state.
**Gate:** refresh mid-sim, state restored; incident persists.

## Phase 4 — Stripe Checkout sandbox + webhooks
Customer creates delivery → Checkout opens → test card pays → webhook signature verified → idempotent paid order → order appears on map *only after* webhook success.
**Gate:** duplicate webhook delivery creates exactly one order.

## Phase 5 — Routing service
FastAPI service; `RoutingProvider` interface; `MockRoutingProvider` + `CuOptRoutingProvider` behind `CUOPT_API_URL`. Wire assignment into the order flow.
**Gate:** mock and cuOpt return same-shaped output; deadline violations surfaced.

## Phase 6 — MCP server
16 typed tools, Zod-validated, idempotent financial actions. Hermes receives structured incident, returns the structured decision JSON. No execution from unstructured text.
**Gate:** malformed tool input rejected; decision schema validated before any action.

## Phase 7 — Nemotron 3 Ultra (via Nous Portal, OpenRouter fallback)
Hermes reasons via Nemotron, reached through Nous Portal using existing Nous credits (`hermes model` config, no separate SDK), with OpenRouter wired as a one-line fallback; structured-output contract enforced; output validated before any operational action.
**Gate:** Nemotron output failing schema is rejected, not executed; provider fallback switch tested once.

## Phase 8 — NemoClaw runtime
Run Hermes through full `nemohermes` quickstart. Tool restrictions, network policy, credential isolation, spend policy, per-role permissions, audit logs.
**Gate:** an over-budget or out-of-role action is blocked and logged.

## Phase 9 — Stripe Connect payouts
Simulated connected accounts per driver; test-mode payouts/transfers for replacements; Stripe references stored in ledger.
**Gate:** two replacement payouts created in test mode, ledgered, idempotent.

## Phase 10 — Stripe Projects operation
Hermes detects rising event volume → evaluates whether more queue/observability infra is needed → NemoClaw checks policy → Stripe Projects provisions/upgrades the approved service → expense + result recorded.
**Gate:** one real provisioning/upgrade operation demonstrated and ledgered.

## Phase 11 — Demo polish
Incident countdown, revenue-at-risk counter, agent action timeline, Nemotron decision panel, NemoClaw policy panel, Stripe transaction panel, animated route transitions, recovery status, final financial report.
**Gate:** full DEMO_SCRIPT runs start to finish with 0 human interventions, 0 policy violations.

---

## Working rules
- Never generate the whole app in one step. Small testable milestones.
- Before each milestone: state which files will be created/changed.
- After each milestone: lint, typecheck, unit tests (integration where applicable).
- Snehal reviews prompts → sends to Cursor (which has filesystem + built the codebase). Always read existing files/architecture before writing fix prompts. Never approve recursive deletes near `.git` or config. Stop for approval at each step of sensitive operations.
- Custom 3D vehicle models come last, after the deterministic business sim is solid.
