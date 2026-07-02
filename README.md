# HermesRoutiq - Autonomous Delivery Operations Company

[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Python-green?logo=fastapi)](https://fastapi.tiangolo.com/)
[![Hermes Agent](https://img.shields.io/badge/Hermes%20Agent-Nous%20Research-red)](https://github.com/NousResearch/hermes-agent)
[![Stripe](https://img.shields.io/badge/Stripe-Checkout%20%2B%20Connect-635BFF?logo=stripe)](https://stripe.com/)
[![NVIDIA cuOpt](https://img.shields.io/badge/NVIDIA-cuOpt-76B900)](https://build.nvidia.com/nvidia/cuopt)

HermesRoutiq is a prototype **autonomous delivery company** for last-mile operations — an agent that can **earn, spend, and run real operations** for a delivery business.
It shows how a Hermes agent can monitor a live fleet, react to a vehicle failure, evaluate financial risk, call routing and payment tools, and drive recovery in real time.

Built for the **Hermes Agent Accelerated Business Hackathon** by Nous Research, NVIDIA, and Stripe.

## Demo

[![Watch the HermesRoutiq demo on YouTube](https://img.youtube.com/vi/QxU-MQ4tS48/maxresdefault.jpg)](https://youtu.be/QxU-MQ4tS48)

**Watch the full walkthrough: [youtu.be/QxU-MQ4tS48](https://youtu.be/QxU-MQ4tS48)**

The agent recovers a live vehicle breakdown end to end — reading state, comparing options, paying a replacement driver through Stripe Connect, and banking the recovery as a reusable skill.

| Recovery complete | Real Stripe Connect payout |
|---|---|
| ![Recovery complete panel showing 1/1 deliveries recovered, net financial benefit, 146s recovery time, and the vehicle_breakdown_recovery skill learned from the incident](docs/assets/recovery-complete.png) | ![Stripe sandbox transfer of US$4.00 labelled HermesRoutiq incident payout for driver driver-2](docs/assets/stripe-connect-payout.png) |

![Dashboard payments feed showing an outgoing replacement driver payout and an incoming Stripe Checkout payment](docs/assets/dashboard-payments.png)

## The problem

Last-mile delivery breaks down fast when a driver or vehicle fails mid-route:

- an active order is suddenly at risk
- customer refunds and churn become likely
- dispatch teams need a replacement decision immediately
- rerouting, payouts, and audit trails have to happen under pressure

HermesRoutiq turns that failure into an autonomous operations workflow.

## What HermesRoutiq does

- Runs a live delivery control room on a 2.5D city map
- Tracks active deliveries, incidents, policy checks, and payments
- Lets Hermes reason through breakdown recovery in real time
- Uses routing services to assign or reroute delivery work
- Uses Stripe to handle checkout and driver payout flows
- Persists operational state, decisions, and financial records for auditability

## Demo focus

The strongest demo path in this repo is the **vehicle breakdown scenario**:

1. A customer delivery is created and released onto the map
2. A vehicle breaks down while carrying active work
3. Hermes detects the incident context and reviews available options
4. Routing and policy tools are called to recover the operation
5. The UI shows the live recovery path, reasoning feed, and outcome

## Tech stack

| Layer | Technologies |
|---|---|
| **Agent** | Hermes Agent, NemoHermes / NemoClaw sandbox, Nemotron 3 Ultra |
| **Frontend** | Next.js 14, React 18, Tailwind CSS, MapLibre GL, deck.gl |
| **Operations Core** | TypeScript, Node.js, Zod, MCP server |
| **Routing** | FastAPI, NVIDIA cuOpt, OSRM |
| **Simulation** | Python ambient traffic simulator, seeded delivery world |
| **Data** | Supabase Postgres, Redis |
| **Payments** | Stripe Checkout, Stripe webhooks, Stripe Connect, Stripe Projects |

## Architecture

```mermaid
flowchart TD
  customer(["Customer"])
  operator(["Operator / Judge"])

  web["Next.js web app<br/>dashboard · checkout · API routes"]
  bridge["Hermes Bridge · FastAPI<br/>OpenAI-compatible /v1/chat/completions"]
  sim["Ambient Simulator · FastAPI"]

  subgraph sandbox["NemoClaw / OpenShell sandbox — Docker in WSL · hermes-runway"]
    direction TB
    hermes["Hermes Agent · NemoHermes"]
    skills["Skills — sandbox-side<br/>operator + learned recovery"]
    mcpcfg["Hermes mcp_servers<br/>5 role-scoped connections"]
    hermes --> skills
    hermes --> mcpcfg
  end

  nemotron["Nemotron 3 Ultra<br/>via OpenRouter (compatible-endpoint)"]

  subgraph core["Operations core — host"]
    direction TB
    mcp["MCP Server · Node/TS · Streamable HTTP<br/>27 tools · role-scoped · spend policy · audit"]
    routing["Routing Service · FastAPI<br/>NVIDIA cuOpt + OSRM"]
    mcp --> routing
  end

  subgraph data["State + payments"]
    direction LR
    pg[("Supabase<br/>Postgres")]
    redis[("Redis")]
    stripe["Stripe<br/>Checkout · Connect · Projects"]
  end

  customer --> web
  operator --> web
  web --> sim
  web -->|trigger reasoning| bridge
  bridge -->|docker exec / WSL| hermes
  hermes -->|reasons on| nemotron
  mcpcfg -->|"x-routiq-role · egress gated by OpenShell"| mcp
  web <-. "checkout / webhooks" .-> stripe
  mcp --> pg
  mcp --> redis
  mcp --> stripe

  classDef user fill:#0f172a,stroke:#64748b,color:#f8fafc;
  classDef app fill:#0c4a6e,stroke:#38bdf8,color:#e0f2fe;
  classDef agent fill:#3b0764,stroke:#c084fc,color:#f5e8ff;
  classDef model fill:#14532d,stroke:#4ade80,color:#dcfce7;
  classDef store fill:#422006,stroke:#f59e0b,color:#fef3c7;

  class customer,operator user;
  class web,bridge,sim,mcp,routing app;
  class hermes,skills,mcpcfg agent;
  class nemotron model;
  class pg,redis,stripe store;
```

## How it works

### 1. Delivery intake

The web app creates a customer payment flow through Stripe Checkout.
Once payment is confirmed, the order becomes operationally eligible for dispatch.

### 2. Dispatch and routing

The operations layer persists the order, selects an available vehicle, and requests route optimization through the routing service.
cuOpt handles assignment logic and OSRM supplies road-following geometry for the map.

### 3. Live simulation

The map shows active vehicles, route overlays, traffic zones, and signal context while the ambient simulator keeps the city visually alive.

### 4. Incident response

When a vehicle breakdown is triggered, Hermes receives the incident context, reviews affected deliveries, checks available recovery options, and requests the tools it needs.

### 5. Recovery execution

The system can reassign work, replan routes, run policy checks, record decisions, and process payout-related operations while keeping the operator UI in sync.

## Hermes tools & skills

Hermes acts only through **27 typed, role-scoped MCP tools** (Zod-validated, spend-policy-gated, and audit-logged) plus a library of **skills** it reuses and improves across incidents.

### Tools by role

**Monitoring** — read-only situational awareness
- `get_business_snapshot` — fleet, orders, and financial state at a glance
- `get_active_orders` — orders currently assigned or in transit
- `get_incident_details` — full context for an active incident

**Routing** — dispatch and route optimization (cuOpt + OSRM)
- `get_driver_location` — a vehicle's current position
- `get_available_drivers` — idle drivers available to reassign
- `preview_paid_order_dispatch` — preview the assignment/route before release
- `request_route_optimisation` — solve the fleet VRP with cuOpt
- `apply_congestion_recovery_route` — reroute a vehicle around a congestion zone
- `apply_breakdown_recovery_reroute` — move a broken vehicle's orders onto replacements
- `dispatch_paid_order` — release a paid order to a vehicle

**Finance** — money-aware decisioning
- `calculate_financial_exposure` — revenue at risk, refund and churn exposure
- `check_spending_policy` — enforce the spend cap (approve/deny)
- `compare_recovery_options` — score recovery strategies by expected net benefit
- `provision_event_surge_capacity` — provision surge capacity via Stripe

**Operations** — execute and record the recovery
- `assign_replacement_driver` — assign a replacement to affected orders
- `provision_infrastructure` — provision a service via Stripe Projects
- `ensure_pending_checkout_order` — create/ensure a pending checkout order
- `mark_checkout_order_paid` — mark a checkout order paid
- `record_payment_declined_incident` — log a declined-payment incident
- `record_operational_event` — log an operational event
- `complete_delivery_recovery` — finalize recovery once the vehicle arrives
- `verify_delivery_recovery` — confirm recovered orders delivered
- `send_customer_notification` — notify the affected customer
- `record_agent_decision` — log reasoning, options, and selection
- `create_recovery_skill` — save a reusable recovery skill (learning loop)

**Payment** — real Stripe money movement (idempotent)
- `create_driver_payout` — pay a driver via Stripe Connect transfer
- `issue_customer_refund` — refund a customer

### Skills

**Capability skills** (`.agents/skills/`) — installed agent capabilities
- **`stripe-projects-cli`** — provision, deploy, and access third-party services and sync their credentials through the Stripe Projects CLI (the repo is a live Stripe project).
- **`sp-inngest`** — Inngest provider guidance generated via `stripe projects llm-context` for the provisioned Inngest service.

**Learned recovery skills** (`skills/`) — created and reused by the learning loop
- **`hermes-routiq-operator`** — master operator skill: project context for dispatch, recovery, incidents, routing, policy, payouts, and notifications.
- **`vehicle_breakdown_recovery`** — compare net benefit, assign replacement driver(s), pay recovery incentives, verify completion, notify customers.
- **`congestion_recovery`** — freeze the affected vehicle, reroute around the blocked zone, resume once the new route persists, and store the reroute pattern for reuse.
- **`payment_declined_recovery`** — keep dispatch blocked, contact the customer with a retry path, and preserve fleet capacity until payment succeeds.

## NVIDIA cuOpt — the routing brain

Every "who drives what, in what order" decision — normal dispatch **and** breakdown/congestion recovery — is solved by **[NVIDIA cuOpt](https://build.nvidia.com/nvidia/cuopt)**, NVIDIA's GPU-accelerated route-optimization engine. This is a real vehicle-routing solve against NVIDIA's managed cuOpt endpoint, not a nearest-neighbour heuristic or a mock.

- **Where it lives:** `services/routing/app/providers/cuopt_provider.py`, behind a `RoutingProvider` interface. `cuopt-osrm` is the default provider (`ROUTING_PROVIDER`).
- **Real VRP model:** cuOpt receives a full vehicle-routing problem — fleet capacities, per-vehicle time windows and max drive times, and per-task demand, service time, and delivery windows.
- **Real road costs:** OSRM builds the distance + travel-time cost matrix over the actual street network (`services/routing/app/cost_matrix.py`), so cuOpt optimizes on real drive times, not straight lines.
- **Managed NVCF flow:** requests go to `optimize.api.nvidia.com/v1/nvidia/cuopt` with async submit → status poll → result download.
- **Rich solution:** cuOpt returns optimal vehicle→task assignments, stop sequencing, and arrival stamps, which become routes, ETAs, unassigned/dropped tasks, and deadline violations.

The exact vehicle-routing problem sent to cuOpt (`services/routing/app/providers/cuopt_provider.py`):

```python
    def _build_cuopt_payload(
        self,
        drivers: list[DriverInput],
        orders: list[OrderInput],
        index_by_key: dict[str, int],
        duration_matrix: list[list[float]],
        distance_matrix: list[list[float]],
    ) -> dict[str, Any]:
        return {
            "cost_matrix_data": {"data": {"0": distance_matrix}},
            "travel_time_matrix_data": {"data": {"0": duration_matrix}},
            "fleet_data": {
                "vehicle_ids": [driver.id for driver in drivers],
                "vehicle_locations": [
                    [
                        index_by_key[f"driver-start:{driver.id}"],
                        index_by_key[f"driver-end:{driver.id}"],
                    ]
                    for driver in drivers
                ],
                "capacities": [
                    [max(driver.capacity - driver.current_load, 0) for driver in drivers]
                ],
                "vehicle_time_windows": [
                    [driver.time_window.start, driver.time_window.end] for driver in drivers
                ],
                "vehicle_max_times": [
                    driver.max_travel_time_seconds
                    if driver.max_travel_time_seconds is not None
                    else driver.time_window.end - driver.time_window.start
                    for driver in drivers
                ],
                "vehicle_types": [0 for _ in drivers],
                "drop_return_trips": [False for _ in drivers],
            },
            "task_data": {
                "task_ids": [order.id for order in orders],
                "task_locations": [index_by_key[f"order:{order.id}"] for order in orders],
                "demand": [[order.demand for order in orders]],
                "service_times": [order.service_time_seconds for order in orders],
                "task_time_windows": [
                    [
                        order.time_window.start if order.time_window else 0,
                        order.time_window.end if order.time_window else 86_400,
                    ]
                    for order in orders
                ],
            },
        }
```

**In the demo:** when a truck breaks down, Hermes calls cuOpt through the MCP `request_route_optimisation` and recovery tools to re-solve the VRP for the surviving fleet — reassigning the stranded stops and resequencing deliveries so the replacement route is optimal, not just "next closest." Config lives in `services/routing/.env.example` (`CUOPT_API_URL`, `CUOPT_STATUS_API_URL`, `CUOPT_API_KEY`). Full deep dive: **[docs/CUOPT.md](docs/CUOPT.md)**.

## Why this matters

HermesRoutiq is not just a route viewer.
It is a prototype for an autonomous company where an agent helps run dispatch, recovery, and business operations together:

- **routing intelligence** powered by NVIDIA cuOpt for assignment and recovery
- **financial awareness** around payouts, refunds, and margin
- **policy enforcement** before risky actions execute
- **live visibility** for operators and judges watching the system work

## Project structure

```text
HermesRoutiq/
|-- apps/web/               # Next.js dashboard, API routes, checkout UI
|-- packages/shared/        # Shared types across frontend and services
|-- services/mcp-server/    # Hermes tool server and reasoning orchestration
|-- services/routing/       # FastAPI routing service for cuOpt + OSRM
|-- services/simulator/     # Ambient traffic and signal simulation
|-- services/hermes-bridge/ # Bridge into local Hermes runtime
|-- supabase/               # Migrations and seed data
|-- docs/                   # Architecture, security, setup, demo notes
`-- ops/nemoclaw/           # NemoClaw / sandbox helper scripts
```

## Quick start

### Prerequisites

- Node.js 20+
- Python 3.10+
- Supabase project
- Redis
- Stripe test keys
- Hermes runtime / NemoHermes setup for full agent flow

### Local development

1. Clone the repo
2. Install workspace dependencies
3. Copy environment files and configure keys (`apps/web/.env.example` → `apps/web/.env.local`, plus `.env.example`, `services/mcp-server/.env.example`, `services/routing/.env.example`). Next.js only auto-loads env from `apps/web/`, so the dashboard's Supabase/Stripe keys must live in `apps/web/.env.local`.
4. Run database setup
5. Start the routing service
6. Start the simulator
7. Start the MCP server
8. Start the web app

Useful commands:

```bash
npm install
npm run db:setup
npm run mcp:dev
npm run dev
```

Routing service:

```bash
cd services/routing
python -m uvicorn app.main:app --reload --port 8001
```

Ambient simulator:

```bash
cd services/simulator
python -m uvicorn app.main:app --reload --port 8010
```

For the full Hermes sandbox path, see [docs/NEMOCLAW_SETUP.md](docs/NEMOCLAW_SETUP.md).

## Documentation

- [Architecture](ARCHITECTURE.md)
- [NVIDIA cuOpt routing](docs/CUOPT.md)
- [Security policy](docs/SECURITY_POLICY.md)
- [NemoClaw setup](docs/NEMOCLAW_SETUP.md)

## Hackathon submission

Built for the **Hermes Agent Accelerated Business Hackathon** (Nous Research, NVIDIA, Stripe).

The brief asked for agents that **earn, spend, and run real operations** — run **safely** through NemoClaw, **quickly** on Nemotron 3 Ultra, **intelligently** with agent skills, and using **Stripe Skills** to buy what they need, provision their own SaaS, and pay for the services they use. HermesRoutiq maps to each:

| Sponsor | Integration in HermesRoutiq |
|---|---|
| **Nous / Hermes** | Hermes agent that runs the delivery ops loop — monitor, decide, recover — with operator + **learned recovery skills** it banks after each incident |
| **NVIDIA** | **safely** (NemoClaw sandbox isolation) · **quickly** (Nemotron 3 Ultra reasoning via OpenRouter) · **intelligently** (**cuOpt** VRP for dispatch + breakdown/congestion recovery) |
| **Stripe** | **earns** via Checkout · **pays for what it uses** through Connect driver payouts + customer refunds · **provisions its own SaaS** via the Stripe Projects / Billing surge-capacity pattern |

**Demo:** [YouTube walkthrough](https://youtu.be/QxU-MQ4tS48) · **Setup:** [NemoClaw](docs/NEMOCLAW_SETUP.md) · **MCP env:** [services/mcp-server/.env.example](services/mcp-server/.env.example)

HermesRoutiq asks one question:

**Can Hermes run part of a delivery company end to end when operations go wrong?**

This repo answers it through a live breakdown-and-recovery demo that combines agent reasoning, cuOpt routing, policy constraints, Stripe payments, and operational visibility.

## Credits

- **Nous Research** - Hermes Agent
- **NVIDIA** - Nemotron 3 Ultra, cuOpt, NemoClaw / NemoHermes context
- **Stripe** - Checkout, Connect, Projects
- **Snehal707** - HermesRoutiq

## License

Released under the [MIT License](LICENSE).
