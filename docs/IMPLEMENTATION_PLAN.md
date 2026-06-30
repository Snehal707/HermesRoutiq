# HermesRoutiq - Implementation Plan

Eleven phases. Each phase has an exit gate; you do not start the next phase until the gate passes. Lint + typecheck + unit tests run at every milestone; integration tests where applicable. Mocks are fine during development. The final demo must use the real sponsor surfaces (Hermes, Nemotron 3 Ultra, NemoClaw, cuOpt, Stripe Checkout/webhooks/Connect/Projects) - no silent mock substitution.

## Audited Status - 2026-06-29

| Phase | Status | Notes |
|---|---|---|
| 0 | Partial | Real sponsor surfaces are wired, but the direct Stripe Projects CLI provisioning path is still KYC-blocked and Phase 8's native NemoClaw per-tool gate is still not fully provable. |
| 1 | Done | Core architecture, security, demo, and setup docs exist. |
| 2 | Done | Deterministic seeded simulator and visible map controls are live in the app. |
| 3 | Done | Postgres + Redis persistence verified earlier and retained. |
| 4 | Done | Stripe Checkout + webhook flow verified earlier and retained. |
| 5 | Done | Live dispatch and congestion reroute are using `cuopt-osrm` road routes in the running sim. |
| 6 | Done | `npm test -w services-mcp-server` passed `17/17` on 2026-06-29 after fixing env/test isolation and schema drift. |
| 7 | Partial | Structured reasoning validation is green, and the live NemoHermes profile is configured for Nemotron via OpenRouter; the remaining gap is that the repo still keeps alternate/fallback reasoning paths and stale wording that needed cleanup. |
| 8 | Partial | NemoClaw/NemoHermes runtime is real, but native per-MCP-tool role gating is not exposed by the current runtime version. |
| 9 | Done | Stripe Connect payout proof passed live on 2026-06-29, including idempotency and spend-cap denial. |
| 10 | Done | Stripe Projects provisioning-pattern proof passed live on 2026-06-29 using real Stripe Billing artifacts plus policy + ledger audit. |
| 11 | In progress | UI/demo polish still needs final end-to-end timing polish and operator-flow cleanup. |

---

## Phase 0 - Verify sponsor surfaces (do this before docs are "done")
Network is needed for these; confirm each and record the real values in `.env`:
- Nemotron provider wiring must be verified against the active Hermes profile. On this machine the verified live profile is OpenRouter with `nvidia/nemotron-3-ultra-550b-a55b`; Nous Portal remains an alternate configuration path if the team switches profiles later. Smoke-test the active profile with one chat turn before wiring MCP.
- Stripe Skills install line works: `npx skills add https://docs.stripe.com --skill stripe-projects -g -y`.
- cuOpt reachable via chosen `CUOPT_API_URL` (managed endpoint or local NIM).
- NemoClaw `nemohermes` quickstart runs end to end against Hermes, with the active provider key isolated as a Hermes-only credential.
**Gate:** a one-call smoke test against each surface returns 200/valid.

## Phase 1 - Documentation (current phase)
`ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `SECURITY_POLICY.md`, `DEMO_SCRIPT.md`, repo tree, env vars, risks, first milestone defined. No application code before these are complete.
**Gate:** docs reviewed; repo tree scaffolded empty.

## Phase 2 - Map + deterministic simulator (FIRST CODE MILESTONE)
Next.js app renders the 2.5D city; 8 drivers spawn and move along predefined seeded routes; pickup hubs + customer destinations render; sim controls (start/pause/reset/speed) work; breakdown button stops a vehicle and turns it red. No DB, no Hermes, no Stripe yet - in-memory seeded state only.
**Gate:** same seed -> identical movement; breakdown visibly fires.

## Phase 3 - Postgres + Redis DONE
Supabase migrations for all tables; simulator writes through to Postgres; live state in Redis; browser refresh recovers state.
**Gate:** refresh mid-sim, state restored; incident persists.
**Gate evidence:** Reset -> Start -> wait -> refresh -> resume mid-route verified; breakdown -> refresh -> incident persists verified; repeat breakdown after reset verified with two distinct incident UUIDs and no duplicate-key errors. Production build passes.

## Phase 4 - Stripe Checkout sandbox + webhooks DONE
Customer creates delivery -> Checkout opens -> test card pays -> webhook signature verified -> idempotent paid order -> order appears on map only after webhook success.
**Gate:** duplicate webhook delivery creates exactly one order.
**Gate evidence:** real Stripe Checkout sandbox payment completed and redirected back; redirect alone created no order (count stayed 4, paid stayed 0); verified webhook then created exactly one paid order (count 5, paid 1); signed replay returned `created: false` and count stayed 5; unsigned webhook returned 400 and performed no write. Lint, typecheck, and production build pass.

## Phase 5 - Routing service DONE
FastAPI service; `RoutingProvider` interface; `MockRoutingProvider` + `CuOptRoutingProvider` behind `CUOPT_API_URL`. Wire assignment into the order flow.
**Gate:** mock and cuOpt return same-shaped output; deadline violations surfaced.
**Gate evidence:** live dispatch and live congestion recovery both persisted `cuopt-osrm` road routes on 2026-06-29, and the MCP integration suite passed the `request_route_optimisation` path against the running data model.

## Phase 6 - MCP server DONE
Role-scoped typed MCP tools, Zod-validated, with idempotent financial actions. Hermes receives structured incident, returns the structured decision JSON. No execution from unstructured text.
**Gate:** malformed tool input rejected; decision schema validated before any action.
**Gate evidence:** `npm test -w services-mcp-server` passed `17/17` on 2026-06-29 after fixing proof-script env precedence, boolean env parsing, and output-schema drift.

## Phase 7 - Nemotron 3 Ultra
Hermes reasons via Nemotron, with the active provider determined by the live Hermes profile config. In the currently verified setup that is OpenRouter with `nvidia/nemotron-3-ultra-550b-a55b`; alternate provider wiring remains possible as a profile-level change. Structured-output contract enforced; output validated before any operational action.
**Gate:** Nemotron output failing schema is rejected, not executed; provider fallback switch tested once.
**Current status note:** the verified live NemoHermes profile is configured for `nvidia/nemotron-3-ultra-550b-a55b` via `openrouter` inside Hermes's own profile config. The repo still retains a bridge/fallback path named `hermes_local`, but that transport label is not the same thing as the inner model actually used by the live sandbox profile.

## Phase 8 - NemoClaw runtime
Run Hermes through full `nemohermes` quickstart. Tool restrictions, network policy, credential isolation, spend policy, per-role permissions, audit logs.
**Gate:** an over-budget or out-of-role action is blocked and logged.
**Current status note:** only partially provable in the current runtime. See `docs/NEMOCLAW_SETUP.md` for the exact limitation: the shipped NemoClaw/NemoHermes build on this machine does not expose a native per-MCP-tool role allow/deny layer, so role scoping is still enforced in our MCP application policy.

## Phase 9 - Stripe Connect payouts DONE
Simulated payout accounts per driver; test-mode payouts/transfers for replacements; Stripe references stored in ledger.
**Gate:** two replacement payouts created in test mode, ledgered, idempotent.
**Gate evidence:** `npx tsx services/mcp-server/scripts/prove-stripe-driver-payouts.ts` passed live on 2026-06-29. It created two real test-mode transfers, proved duplicate idempotency returned the same transfer, and proved a 2500-cent payout was denied under the 2000-cent policy cap.

## Phase 10 - Stripe Projects operation DONE
Hermes detects rising event volume -> evaluates whether more queue/observability infra is needed -> NemoClaw/application policy checks role + spend -> Stripe records the approved infrastructure action -> expense + result recorded.

Stripe Projects status for this repo:
- Verified real: `npx skills add https://docs.stripe.com --skill stripe-projects -g -y` exposes a real Projects workflow; `stripe projects catalog --json` returned live providers/services; `projects.dev` and the CLI surface are current.
- Verified blocker: `stripe projects init` works up to browser pairing, then requires real platform-account activation / KYC before sandbox use. That is a genuine product gate, not a missing code path in this repo.
- Honest fallback for the demo: implement a **Stripe Projects provisioning pattern** in application code. The trigger, role gate, spend gate, audit rows, and ledger row are all real; the final Stripe action is a real Billing API object creation representing the infra upgrade because the direct Projects CLI path is KYC-blocked.

**Gate:** one real provisioning-pattern operation demonstrated via Stripe API, policy-logged, and ledgered, with the KYC limitation documented explicitly.
**Gate evidence:** `stripe projects status --json` confirmed the real HermesRoutiq project is active, and `npx tsx services/mcp-server/scripts/prove-stripe-projects-pattern.ts` passed live on 2026-06-29 by creating a real Stripe Product + recurring Price as the documented provisioning-pattern fallback, together with matching policy rows and ledger rows.

## Phase 11 - Demo polish
Incident countdown, revenue-at-risk counter, agent action timeline, Nemotron decision panel, NemoClaw policy panel, Stripe transaction panel, animated route transitions, recovery status, final financial report.
**Gate:** full DEMO_SCRIPT runs start to finish with 0 human interventions, 0 policy violations.
**Current status note:** still in progress. The core business flows are now much more honest, but final visual timing, route-legibility, and operator-flow polish still need one more end-to-end pass.

---

## Working rules
- Never generate the whole app in one step. Small testable milestones.
- Before each milestone: state which files will be created/changed.
- After each milestone: lint, typecheck, unit tests (integration where applicable).
- Snehal reviews prompts -> sends to Cursor (which has filesystem + built the codebase). Always read existing files/architecture before writing fix prompts. Never approve recursive deletes near `.git` or config. Stop for approval at each step of sensitive operations.
- Custom 3D vehicle models come last, after the deterministic business sim is solid.
