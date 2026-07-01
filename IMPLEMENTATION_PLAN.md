# HermesRoutiq Implementation Plan

HermesRoutiq is built as an autonomous delivery operations prototype.
This plan tracks the major layers required to move from a seeded simulation to a live agent-driven business workflow.

## Build objective

The project aims to prove one clear story:

**A Hermes agent can help run a delivery company by coordinating dispatch, routing, recovery, payments, and audit visibility from one operational surface.**

## Success criteria

HermesRoutiq is considered demo-ready when it can:

- accept a delivery request and release it after payment
- assign a route and render it on the map
- surface a live delivery incident
- let Hermes evaluate recovery options through tools
- execute recovery actions with policy and payment controls
- show a clear operator-facing audit trail of what happened

## Delivery roadmap

### Phase 1. Product and system design

- define the control-room experience
- define the agent, routing, simulator, and payment boundaries
- document architecture, trust boundaries, and setup flow

Status: complete

### Phase 2. Deterministic simulation

- render the city map and seeded fleet state
- support repeatable start, pause, reset, and replay flows
- establish a stable visual base for later live operations

Status: complete

### Phase 3. Persistent state

- add database-backed orders, incidents, vehicles, and ledger records
- use Redis for hot operational state and synchronization
- make reloads recover active business state cleanly

Status: complete

### Phase 4. Customer payment intake

- create Stripe Checkout sessions for delivery requests
- confirm paid orders through webhook-backed state transitions
- keep unpaid work off the dispatch map

Status: complete

### Phase 5. Routing layer

- run optimized assignment through NVIDIA cuOpt
- fetch road-following geometry from OSRM
- persist route plans and render them visibly in the dashboard

Status: complete

### Phase 6. Operations tool server

- expose structured business tools through the MCP server
- validate inputs and outputs with typed schemas
- centralize business rules and policy-aware actions in one layer

Status: complete

### Phase 7. Hermes reasoning integration

- connect Hermes to live operational context
- let Hermes inspect incidents, compare recovery options, and select actions
- surface live reasoning output back into the dashboard

Status: complete

### Phase 8. Sandbox and policy containment

- run Hermes inside the NemoHermes / NemoClaw environment
- enforce network and credential isolation through the sandbox
- keep application-level role and tool policy checks in the MCP layer

Status: complete

### Phase 9. Driver payouts and operational finance

- support Stripe Connect payout execution
- store ledger and transfer references for auditability
- tie financial actions to policy-checked recovery execution

Status: complete

### Phase 10. Infrastructure operations

- integrate Stripe Projects-backed provisioning flows
- record infrastructure actions in the same operational ledger
- keep business tooling and infrastructure tooling inside one operator story

Status: complete

### Phase 11. Demo polish

- tighten the live map, recovery, and reasoning experience
- make the breakdown scenario easy to understand visually
- keep the public repo and demo flow clean enough for review

Status: complete

## Proof path

The strongest end-to-end story in the repo is the **paid delivery -> live vehicle breakdown -> Hermes recovery** flow: a customer order is paid through Stripe Checkout, a vehicle fails mid-route, and Hermes reasons over recovery options, re-solves routing through NVIDIA cuOpt, runs policy checks, and pays a replacement driver through Stripe Connect — all with an operator-facing audit trail.

## Related docs

- [README](README.md)
- [Architecture](ARCHITECTURE.md)
- [NemoClaw setup](docs/NEMOCLAW_SETUP.md)
- [Security policy](docs/SECURITY_POLICY.md)
- [Demo script](docs/DEMO_SCRIPT.md)
