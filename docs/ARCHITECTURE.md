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

**Trust boundary:** Hermes never holds the Stripe secret key, never gets raw DB access, never executes SQL or shell. It only sees the typed MCP tools. In the current repo, role-scoped HTTP MCP sessions expose only the tools for that claimed role, and every financial action is still re-validated by the policy engine inside the Node core. Two layers on purpose: NemoClaw protects the Hermes runtime boundary, while our MCP layer enforces tool visibility, idempotency, ledger consistency, and spend caps.

---

## 2. Components

### apps/web (Next.js, TypeScript, Tailwind)
The operations dashboard and the customer checkout. Renders the 2.5D city via MapLibre GL JS (building extrusion) with deck.gl `TripsLayer` for animated routes. Holds **no business logic** beyond Stripe Checkout session creation and webhook receipt. Subscribes to the Node core WS stream for all live state. The map is a *view* of simulator state, never a source of truth.

### services/simulator (Node)
Deterministic simulation driven by a fixed `SIMULATION_SEED`. Owns the clock. Emits `SIMULATION_EVENTS` (vehicle moves, status changes, incidents) onto the WS hub and persists them. Same seed ⇒ identical demo every run. Exposes control verbs: start, pause, reset, speed, and the four triggers (breakdown, congestion, driver cancellation, payment failure). The judged path is **breakdown**.

### services/mcp-server (Node)
Hosts the role-scoped MCP tool surface, currently 27 typed tools across the five Routiq roles. Validates every input with Zod. Reads sim/business state from Redis + Postgres, calls the routing provider, calls the policy engine, writes the ledger, and records `AGENT_DECISIONS`. This is the *only* surface Hermes can act through.

### services/routing (Python, FastAPI)
A common `RoutingProvider` interface with two implementations: `MockRoutingProvider` (deterministic, used during frontend work) and `CuOptRoutingProvider`. **cuOpt target abstracted** — the same provider talks to either the managed `build.nvidia.com` endpoint or a self-hosted NIM via `CUOPT_API_URL`. Input: drivers, orders, capacities, loads, time windows, cost matrix, pickup↔delivery pairs. Output: assignments, ordered stops, ETAs, total cost, unassigned, deadline violations.

### Hermes Agent + Nemotron + NemoClaw
Hermes is the autonomous operator. It runs **inside the NemoClaw runtime** (full `nemohermes` quickstart) which gives us the real outer sandbox for network, filesystem, process, and credential isolation. The **currently verified live Hermes profile** is configured for **OpenRouter** with `nvidia/nemotron-3-ultra-550b-a55b` in the sandbox profile config. Nous Portal remains a supported architectural option for Nemotron, but it is not the active live profile on this machine today. Nemotron's 1M-token context comfortably clears Hermes's 64K minimum for multi-step tool-calling sessions. Nemotron analyses incidents and compares recovery strategies, returning *structured JSON only*. Unstructured model text is never executed.

NemoClaw and the model-routing layer are independent concerns: NemoClaw contains the Hermes runtime and isolates its credentials and egress, while the repo's MCP/policy layer decides which business tools Hermes can see and which financial actions are allowed. Nous Portal / OpenRouter is just *how the model call is transported*. Whichever provider key is active, it is a credential NemoClaw should isolate the same way it isolates any other provider key — Hermes's MCP tools never see it directly; it lives in Hermes's own provider config (`~/.hermes/.env` equivalent in the NemoClaw-managed runtime).

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
10. Our MCP policy layer + `check_spending_policy` validate actions and budget (auto cap $20/incident), while NemoClaw continues to isolate the runtime around Hermes.
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

---

## 7. Core Database Tables

All tables live in Supabase Postgres. Live simulation tick state and ephemeral vehicle flags are mirrored in Redis (see Phase 3); durable business records stay here.

### pickup_hubs
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | e.g. `hub-north` |
| name | TEXT NOT NULL | |
| lat | DOUBLE PRECISION NOT NULL | WGS84 |
| lng | DOUBLE PRECISION NOT NULL | WGS84 |

### customer_locations
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | e.g. `customer-1` |
| name | TEXT NOT NULL | |
| lat | DOUBLE PRECISION NOT NULL | WGS84 |
| lng | DOUBLE PRECISION NOT NULL | WGS84 |

### drivers
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| name | TEXT NOT NULL | |
| vehicle_id | TEXT NOT NULL | matches `vehicles.id` (no FK — avoids circular refs) |
| stripe_payout_account_id | TEXT | Stripe payout account id for driver replacement payouts |

### vehicles
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| driver_id | TEXT NOT NULL REFERENCES drivers(id) | |
| route | JSONB NOT NULL | array of `[lng, lat]` waypoints |
| route_status | TEXT NOT NULL | `normal`, `at_risk`, `incident`, `recovery`, `completed` |
| status | TEXT NOT NULL | `idle`, `en_route`, `incident`, `completed` |
| speed_mps | DOUBLE PRECISION NOT NULL | |
| frozen_at_seconds | DOUBLE PRECISION | null unless broken down |

### orders
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| customer_id | TEXT NOT NULL REFERENCES customer_locations(id) | |
| pickup_hub_id | TEXT NOT NULL REFERENCES pickup_hubs(id) | |
| vehicle_id | TEXT NOT NULL REFERENCES vehicles(id) | |
| status | TEXT NOT NULL | |
| revenue_cents | INTEGER NOT NULL | |

### incidents
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| type | TEXT NOT NULL | `vehicle_breakdown`, etc. |
| vehicle_id | TEXT NOT NULL REFERENCES vehicles(id) | |
| order_ids | JSONB NOT NULL | array of order id strings |
| created_at_sim_seconds | DOUBLE PRECISION NOT NULL | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

### agent_decisions
| Field | Type | Notes |
|---|---|---|
| id | UUID PK DEFAULT gen_random_uuid() | |
| incident_id | TEXT REFERENCES incidents(id) | |
| reasoning_summary | TEXT | |
| options | JSONB | |
| selected_option | JSONB | |
| expected_cost_cents | INTEGER | |
| expected_benefit_cents | INTEGER | |
| policy_result | TEXT | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

### ledger
| Field | Type | Notes |
|---|---|---|
| id | UUID PK DEFAULT gen_random_uuid() | |
| entry_type | TEXT NOT NULL | |
| amount_cents | INTEGER NOT NULL | |
| reference_id | TEXT | |
| idempotency_key | TEXT UNIQUE | |
| stripe_reference | TEXT | Stripe object id for payout/refund side effects |
| metadata | JSONB DEFAULT '{}' | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

### simulation_events
| Field | Type | Notes |
|---|---|---|
| id | UUID PK DEFAULT gen_random_uuid() | |
| event_type | TEXT NOT NULL | |
| payload | JSONB NOT NULL DEFAULT '{}' | |
| sim_seconds | DOUBLE PRECISION | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

### customer_notifications
| Field | Type | Notes |
|---|---|---|
| id | UUID PK DEFAULT gen_random_uuid() | |
| order_id | TEXT REFERENCES orders(id) | |
| channel | TEXT NOT NULL | |
| message | TEXT NOT NULL | |
| sent_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

### policy_evaluations
| Field | Type | Notes |
|---|---|---|
| id | UUID PK DEFAULT gen_random_uuid() | |
| action_type | TEXT NOT NULL | |
| amount_cents | INTEGER NOT NULL | |
| allowed | BOOLEAN NOT NULL | |
| reason | TEXT | |
| incident_id | TEXT REFERENCES incidents(id) | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
