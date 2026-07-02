# NVIDIA cuOpt Routing

HermesRoutiq uses **[NVIDIA cuOpt](https://build.nvidia.com/nvidia/cuopt)** — NVIDIA's GPU-accelerated route-optimization engine — as the decision core for every "who drives what, in what order" question. Both normal dispatch and incident recovery (vehicle breakdown, congestion) are solved as a real **vehicle-routing problem (VRP)** against NVIDIA's managed cuOpt endpoint. It is not a nearest-neighbour heuristic and not a mock.

## Where it sits

```text
Hermes (MCP tool: request_route_optimisation / recovery tools)
        |
        v
services/mcp-server  ---- HTTP /route ---->  services/routing (FastAPI)
                                                   |
                                    OSRM cost matrix (real road network)
                                                   |
                                    NVIDIA cuOpt managed endpoint (VRP solve)
                                                   |
                                    routes + assignments + ETAs + violations
```

- Routing lives in its own FastAPI service so optimization, network calls, and geometry stay out of the UI and MCP layers.
- cuOpt is exposed behind a `RoutingProvider` interface, and `cuopt-osrm` is the **default** provider (`ROUTING_PROVIDER`).

| File | Role |
|---|---|
| `services/routing/app/providers/cuopt_provider.py` | The cuOpt integration: payload build, submit/poll/download, solution parsing |
| `services/routing/app/cost_matrix.py` | Builds the OSRM distance + travel-time cost matrix cuOpt optimizes on |
| `services/routing/app/providers/osrm_provider.py` | Road-following geometry + drive times |
| `services/routing/app/providers/base.py` | `RoutingProvider` interface and request/response types |
| `services/routing/app/main.py` | FastAPI `/route` + `/optimize` endpoints and provider resolution |

## Request flow

1. **Index locations.** Every driver start/end and every order location is de-duplicated into a single coordinate list (`_index_locations`).
2. **Build the cost matrix.** OSRM computes real distance and travel-time matrices over the street network (`build_osrm_cost_matrix`). Congestion "avoid areas" are honoured so the solver never assumes a shortcut through a blocked zone.
3. **Build the VRP payload.** Fleet and task data are assembled into cuOpt's schema (`_build_cuopt_payload`).
4. **Submit and poll.** The request is POSTed to NVIDIA's managed cuOpt endpoint; if it returns a request id, the service polls the NVCF status endpoint and downloads the result when fulfilled (`_submit_and_poll`).
5. **Parse the solution.** cuOpt's `vehicle_data` (per-vehicle `task_id` order + `arrival_stamp`) becomes routes, assignments, ETAs, dropped/unassigned tasks, and deadline violations (`_build_routes_from_solution`). Road geometry for the chosen sequence is rendered via OSRM.

## The VRP model sent to cuOpt

- **Fleet (`fleet_data`):** vehicle ids, start/end location indices, remaining **capacities**, per-vehicle **time windows**, per-vehicle **max drive times**, vehicle types, and no forced return trips.
- **Tasks (`task_data`):** task ids, task location indices, per-task **demand**, **service times**, and per-task **delivery time windows**.
- **Costs:** `cost_matrix_data` (distance) and `travel_time_matrix_data` (duration) — both from OSRM, so optimization reflects real drive times rather than straight-line distance.

This means cuOpt is solving a genuine capacitated VRP with time windows (CVRPTW), not just picking the closest driver.

## Endpoints and configuration

Set these in `services/routing/.env.example` (or the repo `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `CUOPT_API_URL` | `https://optimize.api.nvidia.com/v1/nvidia/cuopt` | Managed cuOpt solve endpoint |
| `CUOPT_STATUS_API_URL` | `https://api.nvcf.nvidia.com/v2/nvcf/pexec/status` | NVCF async status/poll endpoint |
| `CUOPT_API_KEY` | _(required)_ | NVIDIA API key (Bearer auth) |
| `OSRM_BASE_URL` | `https://router.project-osrm.org` | OSRM cost matrix + geometry |
| `ROUTING_PROVIDER` | `cuopt-osrm` | Default provider for `/route` |

> The same code path works against a **self-hosted cuOpt NIM** on GPU — point `CUOPT_API_URL` at the NIM and the rest of the flow is unchanged.

## How Hermes uses it

Hermes never talks to cuOpt directly. It calls MCP tools, which call the routing service:

- `request_route_optimisation` — solve/re-solve routing for the active fleet or a specific incident.
- `apply_breakdown_recovery_reroute` — after a breakdown, re-solve the VRP for the **surviving** fleet (the broken vehicle is excluded), reassign the stranded stops, and resequence deliveries so the replacement path is optimal.
- `apply_congestion_recovery_route` — re-solve with the congested area as an avoid zone.
- `dispatch_paid_order` / `preview_paid_order_dispatch` — hub-scoped assignment for newly paid orders.

## Why it matters

When a truck breaks down mid-route in the demo, recovery isn't "send the nearest truck." Hermes asks cuOpt to re-optimize the whole surviving fleet under real capacities, time windows, and road costs — which is exactly the kind of decision a human dispatcher would struggle to make quickly and optimally under pressure. That optimal re-solve is what lets the demo recover the order 1/1 with a transparent incident P&L.

## Related docs

- [README](../README.md)
- [Architecture](../ARCHITECTURE.md)
