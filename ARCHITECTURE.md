# HermesRoutiq Architecture

HermesRoutiq is a prototype autonomous delivery operations stack built around a live breakdown-recovery workflow.
The system combines a customer-facing checkout flow, an operator-facing dispatch UI, a Hermes agent runtime, routing services, and payment infrastructure.

## System overview

```mermaid
flowchart TD
  customer(["Customer"])
  operator(["Operator / Judge"])

  web["Next.js web app<br/>dashboard · checkout · API routes"]
  bridge["Hermes Bridge · FastAPI<br/>OpenAI-compatible /v1/chat/completions"]
  simulator["Ambient Simulator · FastAPI"]

  subgraph runtime["NemoClaw / OpenShell sandbox — Docker in WSL · hermes-runway"]
    direction TB
    hermes["Hermes Agent · NemoHermes"]
    skills["Skills — sandbox-side<br/>operator + learned recovery"]
    mcpcfg["Hermes mcp_servers<br/>5 role-scoped connections"]
    hermes --> skills
    hermes --> mcpcfg
  end

  model["Nemotron 3 Ultra<br/>via OpenRouter (compatible-endpoint)"]

  subgraph core["Operations core — host"]
    direction TB
    mcp["MCP Server · Node/TS · Streamable HTTP<br/>27 tools · role-scoped · spend policy · audit"]
    routing["Routing Service · FastAPI<br/>cuOpt + OSRM"]
    mcp --> routing
  end

  subgraph data["State + payments"]
    direction LR
    postgres[("Supabase<br/>Postgres")]
    redis[("Redis")]
    stripe["Stripe<br/>Checkout · Connect · Projects"]
  end

  customer --> web
  operator --> web
  web --> simulator
  web -->|trigger reasoning| bridge
  bridge -->|docker exec / WSL| hermes
  hermes -->|reasons on| model
  mcpcfg -->|"x-routiq-role · egress gated by OpenShell"| mcp
  web <-. "checkout / webhooks" .-> stripe
  mcp --> postgres
  mcp --> redis
  mcp --> stripe

  classDef user fill:#0f172a,stroke:#64748b,color:#f8fafc;
  classDef app fill:#0c4a6e,stroke:#38bdf8,color:#e0f2fe;
  classDef agent fill:#3b0764,stroke:#c084fc,color:#f5e8ff;
  classDef model fill:#14532d,stroke:#4ade80,color:#dcfce7;
  classDef store fill:#422006,stroke:#f59e0b,color:#fef3c7;

  class customer,operator user;
  class web,bridge,simulator,mcp,routing app;
  class hermes,skills,mcpcfg agent;
  class model model;
  class postgres,redis,stripe store;
```

## Core components

### 1. Web application

`apps/web`

The Next.js app is the main surface for both checkout and operations visibility.
It renders:

- the live 2.5D city map
- active routes and incidents
- Hermes reasoning output
- payment and recovery panels

It also hosts the app-side API routes that coordinate dashboard data, Stripe checkout, and simulation state hydration.

### 2. MCP server

`services/mcp-server`

This is the typed operations layer Hermes uses.
It exposes structured tools for:

- incident inspection
- route optimization requests
- payout and refund workflows
- policy checks
- audit logging
- business state access

This service is where business rules are enforced before actions are executed.

### 3. Hermes bridge

`services/hermes-bridge`

The bridge is a small FastAPI service that exposes an OpenAI-compatible `/v1/chat/completions` endpoint on the host and proxies each request into the **Hermes agent gateway running inside the NemoClaw/OpenShell sandbox** (via `docker exec` / WSL against the `hermes-runway` container). This lets the app-side services trigger a sandboxed reasoning run without embedding model-orchestration logic in the frontend.

Once running, Hermes reasons on Nemotron 3 Ultra and reaches the tool layer **outbound** through its own `mcp_servers` config — five role-scoped connections (`routiq_monitoring`, `routiq_routing`, `routiq_finance`, `routiq_operations`, `routiq_payment`), each sending a distinct `x-routiq-role` header. NemoClaw/OpenShell governs network egress; the MCP server itself registers only that role's tool subset per session and enforces the spend/role policy. Live tool counts per role: monitoring 3, routing 7, finance 4, operations 11, payment 2 (27 total).

### 4. Routing service

`services/routing`

The routing service is a separate FastAPI service that combines:

- **NVIDIA cuOpt** for assignment and recovery optimization
- **OSRM** for road-following geometry

cuOpt receives a real capacitated VRP with time windows (fleet capacities, per-vehicle time windows and max drive times, per-task demand/service/delivery windows) over an OSRM road-network cost matrix, and returns optimal assignments, stop sequencing, ETAs, and deadline violations. This separation keeps optimization and map geometry out of the UI code and makes the incident workflow easier to reason about and debug. See [docs/CUOPT.md](docs/CUOPT.md) for the full integration.

### 5. Ambient simulator

`services/simulator`

The ambient simulator supplies:

- traffic zones
- ambient moving vehicles
- signal lights
- scenario timing

It makes the city feel alive while the business workflow plays out on top of it.

### 6. State and payments

- **Supabase Postgres** stores orders, incidents, vehicles, decisions, ledger entries, policy evaluations, and recovery outcomes.
- **Redis** stores hot simulation state and synchronization markers.
- **Stripe** powers checkout, webhook confirmation, Connect payouts, and project provisioning flows.

## Main operational flow

### Delivery creation

1. A customer request enters through the web app
2. Stripe Checkout confirms payment
3. The order becomes dispatchable
4. Routing is requested
5. The assigned vehicle and route appear in the dashboard

### Vehicle breakdown recovery

1. A live delivery vehicle breaks down
2. The incident is recorded and surfaced on the map
3. Hermes receives the incident context through the bridge and MCP layer
4. Hermes evaluates financial exposure, available drivers, and recovery options
5. Routing tools compute the best recovery path
6. Policy checks and payment actions are enforced before execution
7. The updated route and recovery outcome are rendered back in the UI

## Why the architecture is split this way

### Separate routing service

Routing is isolated because optimization logic, network dependencies, and geometry processing are operational concerns, not UI concerns.

### Separate Hermes bridge

The Hermes runtime has its own sandbox and model/provider lifecycle.
Keeping the bridge separate makes the integration easier to observe and safer to evolve.

### Separate simulator

The ambient simulator changes at a different cadence than order dispatch logic.
Separating it prevents city-simulation concerns from leaking into checkout, MCP tools, or payment workflows.

## Trust and control boundaries

HermesRoutiq is designed so that the agent does not directly own the entire system surface.

- Hermes reasons through tools rather than direct database access
- operational actions flow through the MCP server
- policy and spend checks are enforced at the application layer
- payment infrastructure remains on the controlled service side
- state is persisted outside the frontend so the dashboard can recover after reloads

## Repo map

```text
HermesRoutiq/
|-- apps/web/               # UI, checkout, dashboard API routes
|-- packages/shared/        # Shared types
|-- services/mcp-server/    # Tool server + reasoning orchestration
|-- services/hermes-bridge/ # Hermes runtime bridge
|-- services/routing/       # FastAPI routing service
|-- services/simulator/     # Ambient city simulator
|-- supabase/               # Migrations and seed data
|-- docs/                   # Setup, demo, security docs
`-- ops/nemoclaw/           # Sandbox helper scripts
```

## Related docs

- [README](README.md)
- [Implementation plan](IMPLEMENTATION_PLAN.md)
- [NemoClaw setup](docs/NEMOCLAW_SETUP.md)
- [Security policy](docs/SECURITY_POLICY.md)
