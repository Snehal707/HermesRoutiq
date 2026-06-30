# HermesRoutiq

Autonomous delivery operations that think in routes, risk, and revenue.

Built for the **Hermes Agent Accelerated Business Hackathon** (Nous Research · NVIDIA · Stripe). An AI agent that earns from customers, spends to operate, coordinates real workflows, responds to disruptions, makes financially intelligent decisions, runs inside strict permissions, and learns reusable recovery procedures.

See `docs/` for ARCHITECTURE, IMPLEMENTATION_PLAN, SECURITY_POLICY, DEMO_SCRIPT.

## What's real vs simulated
**Real software:** Stripe Checkout/webhooks/Connect/Projects, Hermes Agent, Nemotron 3 Ultra reasoning, NemoClaw enforcement, cuOpt optimisation, DB/Redis/WS, ledger, skill creation.
**Simulated (deterministic, seeded):** drivers, vehicles, GPS, traffic, packages, the breakdown.

## Decided architecture
- Next.js web + **separate Node core** (simulator + MCP server + WS hub).
- Python FastAPI routing service; **cuOpt abstracted behind a provider interface** (managed endpoint or self-hosted NIM, switched by `CUOPT_API_URL`).
- Hermes runs inside the **full NemoClaw runtime** via the `nemohermes` quickstart.
- Hermes reaches **Nemotron 3 Ultra through Nous Portal** (native Hermes provider, slug `nvidia/nemotron-3-ultra`, billed against existing Nous API credits) with **OpenRouter as a one-line fallback** if Nous Portal hiccups mid-demo.

---

## Major technical risks (and mitigations)

1. **Stripe Projects is the newest, least-proven surface.** Phase 10 depends on it and judges want to see "the agent provisions its own SaaS." → Verify the `npx skills add ... stripe-projects` install and a single provisioning call *first* (Phase 0). Keep the Projects op narrow (one observability/queue upgrade). Have a recorded fallback clip.

2. **~~Nemotron model ID / availability~~ — resolved.** Hermes reaches Nemotron 3 Ultra natively through the Nous Portal provider (`hermes model` → Nous Portal → `nvidia/nemotron-3-ultra`), using existing Nous API credits — no new account, no separate SDK, no guessed slug. OpenRouter is configured as a same-model fallback in case Nous Portal rate-limits or has an outage during judging; switching providers is a `hermes model` config change. Residual risk is provider uptime on the day, covered by the fallback.

3. **cuOpt deployment ambiguity (managed vs NIM/GPU).** NIM needs a GPU; managed endpoint has rate/availability limits. → Provider interface; `MockRoutingProvider` always available as deterministic fallback so the demo never hard-blocks on cuOpt.

4. **NemoClaw end-to-end with Hermes is a moving target.** Full runtime is more setup than a policy shim. → Stand it up early (don't defer to Phase 8 blind); if the quickstart fights back, the in-Node policy engine still enforces business invariants, so security isn't lost while NemoClaw is brought up.

5. **Webhook idempotency & race conditions.** Duplicate Stripe deliveries or out-of-order events can double-create orders/payouts. → Idempotency keys on every Stripe write; dedupe on event id; "order appears only after verified webhook" is a hard rule.

6. **Determinism leaks.** Any stray `Math.random()` breaks reproducibility and makes the financial demo unauditable. → Single seeded PRNG instance threaded through the simulator; lint rule / review gate against direct randomness.

7. **Agent executing unstructured text.** A reasoning model emitting prose that gets parsed into actions is the core safety failure. → Structured JSON only; Zod-validate model output before any action; unstructured text never executes.

8. **WebSocket/sim loop in serverless.** Long-lived loops die in Next.js request lifecycles. → That's why sim/MCP/WS live in the separate Node core, not API routes.

9. **Scope creep into a "real logistics platform."** → Build exactly one polished breakdown scenario. 3D vehicle models last.

---

## FIRST IMPLEMENTATION MILESTONE (Phase 2)

**Goal:** the 2.5D city map + deterministic delivery simulation with moving drivers, active orders, animated routes, and a working vehicle-breakdown button. No DB, no Hermes, no Stripe yet — in-memory seeded state only.

**Files to create/change (state these before coding each step):**
- `apps/web/` — Next.js + TS + Tailwind scaffold.
- `apps/web/lib/prng.ts` — single seeded PRNG (no direct Math.random anywhere).
- `apps/web/lib/sim/world.ts` — seeded world: 8 drivers, 8 vehicles, 2 hubs, 10 customer locations, 4 active orders, 3 of them on the vehicle that will break down.
- `apps/web/lib/sim/clock.ts` — tick loop with start/pause/reset/speed.
- `apps/web/lib/sim/movement.ts` — deterministic interpolation of vehicles along route polylines.
- `apps/web/components/CityMap.tsx` — MapLibre GL (building extrusion) + deck.gl `TripsLayer` overlay.
- `apps/web/components/SimControls.tsx` — start / pause / reset / speed + **Simulate Breakdown**.
- `apps/web/components/Legend.tsx` — colour states (green/yellow/red/blue/grey).
- `packages/shared/types/` — Driver, Vehicle, Order, Incident, route/state enums (shared with later services).

**Acceptance for this milestone:**
1. City map renders with 3D building extrusion.
2. Eight drivers appear and move along predefined routes.
3. Pickup hubs and customer destinations render.
4. Start/pause/reset/speed all work.
5. Breakdown button stops the target vehicle and turns it (and its route) red.
6. Same seed ⇒ identical movement every reload.

**Explicitly NOT in this milestone:** Postgres, Redis, Stripe, MCP, Hermes, Nemotron, NemoClaw, cuOpt, payouts, real routing. Use `MockRoutingProvider`-style precomputed polylines.

After Phase 2 passes its gate, proceed to Phase 3 (Postgres + Redis).
