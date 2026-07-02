# HermesRoutiq - Security Policy

The agent handles money. The threat model is "a reasoning model produces a plausible-but-wrong or adversarially-steered action." Defence is layered: sandbox isolation outside, application policy inside the MCP server, and audit everywhere.

---

## 1. Secrets
- No secrets in source. Ever. All via environment variables.
- Validate required env vars at service start; fail fast with a clear list of what's missing.
- Hermes never receives `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `DATABASE_URL`. These live only in the Node core / routing service.
- Hermes provider credentials such as `OPENROUTER_API_KEY` and `NVIDIA_API_KEY` are scoped to Hermes's own profile config, not exposed to MCP tools or the Node core.
- `.env` is gitignored; commit `.env.example` with empty values only.

## 2. Isolation model (NemoClaw)
NemoClaw is the real outer sandbox. In the current Hermes runtime we have verified it for:
- network egress isolation
- filesystem boundaries
- credential separation between the sandbox and host services

NemoClaw does **not** currently provide a working native per-MCP-tool role gateway for this project/runtime version. We do not claim otherwise in this repo.

## 3. Application-layer role-to-tool policy
Role-to-tool authorization is enforced inside `services/mcp-server` as application policy, modeled on NemoClaw's least-privilege design but implemented by our code.

For HTTP MCP sessions that declare a role header, the server now does two things:
- registers only the tool subset allowed for that role at session initialization time
- keeps the existing per-call authorization check as a fallback safety layer

So the stronger live behavior is:
- disallowed tools are absent from the role-scoped HTTP tool list
- attempts to call a hidden tool return `tool not found`
- allowed tool calls still write authorization audit rows

| Role | Allowed tools |
|---|---|
| Monitoring | `get_business_snapshot`, `get_active_orders`, `get_incident_details` |
| Routing | `get_driver_location`, `get_available_drivers`, `preview_paid_order_dispatch`, `request_route_optimisation`, `apply_congestion_recovery_route`, `apply_breakdown_recovery_reroute`, `dispatch_paid_order` |
| Finance | `calculate_financial_exposure`, `check_spending_policy`, `compare_recovery_options`, `provision_event_surge_capacity` |
| Operations | `assign_replacement_driver`, `provision_infrastructure`, `ensure_pending_checkout_order`, `mark_checkout_order_paid`, `record_payment_declined_incident`, `record_operational_event`, `complete_delivery_recovery`, `verify_delivery_recovery`, `send_customer_notification`, `record_agent_decision`, `create_recovery_skill` |
| Payment | `create_driver_payout`, `issue_customer_refund` |

Requests that claim a role outside that allow-list are hidden at the HTTP tool-surface level where possible, and any allowed per-call authorization decision is logged to `policy_evaluations`.

## 4. MCP tool surface
- The current live role matrix exposes 27 MCP tools across the five role-scoped servers; every input is Zod-validated and rejected on schema failure.
- Hermes never gets raw DB access and never generates SQL for execution.
- No tool executes arbitrary shell.
- All financial tools (`create_driver_payout`, `issue_customer_refund`, Stripe Projects provisioning) are idempotent and keyed so retries do not double-spend.
- Stripe Projects note: the real Projects CLI/catalog was verified, but `stripe projects init` is blocked in sandbox use by platform-account activation/KYC. `provision_event_surge_capacity` is labeled honestly as an application-layer Stripe Projects provisioning pattern that uses real Stripe Billing objects instead of the blocked CLI path.

## 5. Financial integrity
- Every money movement passes a policy function and writes a `ledger` row in the same logical transaction.
- `check_spending_policy` enforces the automatic spend cap. `MAX_AUTOMATIC_INCIDENT_SPEND = 20`, so anything above $20 requires human approval.
- `policy_evaluations` records:
  - every requested money action and its allow/deny result
  - every role-to-tool authorization allow/deny result from the MCP server
- `agent_decisions` records reasoning summary, options, selection, expected cost/benefit, and policy result.
- Recovery plan selection optimises expected net benefit, never raw speed.

## 6. Audit and human-in-the-loop
- Every consequential action writes an audit row before it is considered done.
- Destructive operations require human approval.
- The dashboard surfaces the policy panel so a human can see every allow/deny live.

## 7. Code hardening
- Strict TypeScript across all Node/TS packages.
- Zod at every trust boundary: HTTP in, MCP in, model out.
- Model output is parsed as structured JSON and schema-validated before any action; unstructured text is never executed.

## 8. Determinism as a safety property
A fixed seed means the judged run is reproducible and reviewable. A non-deterministic financial demo is unauditable; determinism here is a security feature, not just a convenience.
