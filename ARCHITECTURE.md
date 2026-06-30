# HermesRoutiq — Architecture

**Tagline:** Autonomous delivery operations that think in routes, risk, and revenue.

HermesRoutiq runs a simulated same-day local delivery company. The *physical world* (drivers, vehicles, GPS, traffic, packages, breakdowns) is simulated and deterministic. The *business operations* (payments, payouts, optimisation, agent reasoning, policy enforcement, audit) are real software calls against real sponsor surfaces.

This document is the contract every later phase must conform to. If code disagrees with this doc, the doc wins until the doc is amended.

---

## 1. System topology

Decided: **Next.js web app + a separate Node service** that owns simulation, the MCP server, and the WebSocket stream. Routing is its own Python service. This keeps the long-lived simulation loop and MCP transport out of Next.js request/response lifecycles, which is the single biggest source of "works in dev, dies in prod" pain.

```
                          ┌─────────────────────────────┐
        customer  ─────▶  │  Next.js web (apps/web)      │
                          │  - dashboard + MapLibre/deck │
                          │  - /api/checkout (Stripe)    │
                          │  - /api/stripe/webhook       │
                          └───────────┬─────────────────┘
                                      │  (HTTP + WS client)
                                      ▼
                          ┌─────────────────────────────┐
                          │  Node core (services/...)    │
                          │  - simulator (det. clock)    │──▶ Redis (sim state)
                          │  - WebSocket event hub       │
                          │  - MCP server (Hermes tools) │──▶ Postgres (Supabase)
                          │  - policy engine             │
                          │  - ledger / Stripe Connect   │
                          └───┬───────────────┬──────────┘
                              │               │
                  (provider iface)        (MCP/stdio or HTTP)
                              ▼               ▼
                ┌──────────────────┐   ┌──────────────────────┐
                │ routing service  │   │  Hermes Agent        │
                │ (FastAPI)        │   │  run inside NemoClaw  │
                │ Mock | cuOpt     │   │  reasons w/ Nemotron  │
                └──────────────────┘   └──────────────────────┘
```

**Trust boundary:** Hermes never holds the Stripe secret key, never gets raw DB access, never executes SQL or shell. It only sees the typed MCP tools. Every financial action it requests is re-validated by the policy engine inside the Node core *after* NemoClaw has already gated it. Two layers on purpose: NemoClaw enforces capability (which tools/budgets this agent role may touch), the policy engine enforces business invariants (idempotency, ledger consistency, per-incident spend cap).

---

## 2. Components

### apps/web (Next.js, TypeScript, Tailwind)
The operations dashboard and the customer checkout. Renders the 2.5D city via MapLibre GL JS (building extrusion) with deck.gl `TripsLayer` for animated routes. Holds **no business logic** beyond Stripe Checkout session creation and webhook receipt. Subscribes to the Node core WS stream for all live state. The map is a *view* of simulator state, never a source of truth.

### services/simulator (Node)
Deterministic simulation driven by a fixed `SIMULATION_SEED`. Owns the clock. Emits `SIMULATION_EVENTS` (vehicle moves, status changes, incidents) onto the WS hub and persists them. Same seed ⇒ identical demo every run. Exposes control verbs: start, pause, reset, speed, and the four triggers (breakdown, congestion, driver cancellation, payment failure). The judged path is **breakdown**.

### services/mcp-server (Node)
Hosts the 16 controlled MCP tools. Validates every input with Zod. Reads sim/business state from Redis + Postgres, calls the routing provider, calls the policy engine, writes the ledger, and records `AGENT_DECISIONS`. This is the *only* surface Hermes can act through.

### services/routing (Python, FastAPI)
A common `RoutingProvider` interface with two implementations: `MockRoutingProvider` (deterministic, used during frontend work) and `CuOptRoutingProvider`. **cuOpt target abstracted** — the same provider talks to either the managed `build.nvidia.com` endpoint or a self-hosted NIM via `CUOPT_API_URL`. Input: drivers, orders, capacities, loads, time windows, cost matrix, pickup↔delivery pairs. Output: assignments, ordered stops, ETAs, total cost, unassigned, deadline violations.

### Hermes Agent + Nemotron + NemoClaw
Hermes is the autonomous operator. It runs **inside the NemoClaw runtime** (full `nemohermes` quickstart — not yet wired, see Phase 8) which enforces tool/network/credential/spend restrictions per agent role. Hermes reaches **Nemotron 3 Ultra** through **OpenRouter** (`hermes model` → OpenRouter → paid slug `nvidia/nemotron-3-ultra-550b-a55b`, *not* the `:free` variant). This was a revision from the original plan: Nous Portal's inference endpoint proved unreliable for agent-style payloads in practice (confirmed via live testing and a known upstream issue), and NVIDIA's own direct free endpoint, while reliable, has 60-120s+ latency unsuitable for interactive tool-calling. OpenRouter aggregates faster backend providers (Nebius, Together, DeepInfra) and reliably returns first tokens in under 2 seconds. Nemotron's 1M-token context comfortably clears Hermes's 64K minimum for multi-step tool-calling sessions. Nemotron analyses incidents and compares recovery strategies, returning *structured JSON only*. Unstructured model text is never executed.

NemoClaw and the model-routing layer are independent concerns: NemoClaw gates what Hermes is *allowed to do* (tools, spend, network), OpenRouter is just *how the model call is transported*. Whichever provider key is active, it is a credential NemoClaw should isolate the same way it isolates any other provider key — Hermes's MCP tools never see it directly; it lives in Hermes's own provider config (`~/.hermes/profiles/routiq/` in the NemoClaw-managed runtime).

### Data plane
- **Supabase Postgres** — durable business records (orders, drivers, vehicles, incidents, decisions, ledger, notifications, policy evals).
- **Redis** — live simulation state, so a browser refresh recovers cleanly.
- **WebSocket hub** — single broadcast channel the dashboard subscribes to.

---

## 3. The judged scenario as a data flow

1. Customer creates a $14 delivery → `/api/checkout` opens Stripe Checkout (sandbox).
2. Payment succeeds → Stripe fires webhook → `/api/stripe/webhook` verifies signature, idempotently creates the paid `ORDER`.
3. Node core asks routing provider (cuOpt) to assign best driver + route.
4. Driver moves across the map (simulator).
5. Breakdown trigger fires on a vehicle carrying 3 orders → `INCIDENT` created, vehicle marked red.
6. MCP delivers structured incident to Hermes (`get_incident_details`, `calculate_financial_exposure`).
7. Nemotron analyses: orders, deadlines, revenue at risk, refunds, compensation, replacement + premium costs, churn, available drivers, expected profit.
8. Hermes calls `request_route_optimisation` → cuOpt returns recovery routes.
9. Nemotron compares strategies (1 driver vs 2 drivers vs wait) on **expected net benefit**, not speed.
10. NemoClaw + `check_spending_policy` validate actions and budget (auto cap $20/incident).
11. `assign_replacement_driver` ×2, `create_driver_payout` ×2 (Stripe Connect sandbox), ledger entries written.
12. Recovery routes render blue; drivers complete deliveries.
13. `verify_delivery_recovery` confirms outcomes; `record_agent_decision` persists the reasoning.
14. `create_recovery_skill` writes/updates `vehicle_breakdown_recovery` skill.
15. Dashboard shows the final financial report.

---

## 4. Colour + state semantics (map)
Green = normal route · Yellow = delivery at risk · Red = incident · Blue = recovery route · Grey = completed. Route changes animate.

---

## 5. Determinism guarantees
A single seed fixes: driver spawn positions, movement, order set, traffic, and the breakdown outcome. The simulator must never call `Math.random()` directly — all randomness flows through a seeded PRNG instance. This is what makes the demo reproducible on stage.

---

## 6. Non-negotiable invariants
- Hermes ⇄ Stripe secret key: never.
- Hermes ⇄ raw SQL / shell: never.
- Every Stripe write carries an idempotency key.
- Every webhook verifies signature before doing work.
- Every financial action passes the policy engine *and* writes the ledger atomically.
- Every consequential action writes an audit row.
- Any single-incident automatic spend above `MAX_AUTOMATIC_INCIDENT_SPEND` ($20) requires human approval.
