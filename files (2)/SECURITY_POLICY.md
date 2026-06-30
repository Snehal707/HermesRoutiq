# HermesRoutiq — Security Policy

The agent handles money. The threat model is "a reasoning model produces a plausible-but-wrong or adversarially-steered action." Defence is layered: capability gating (NemoClaw) outside, business-invariant gating (policy engine) inside, audit everywhere.

---

## 1. Secrets
- No secrets in source. Ever. All via environment variables.
- Validate required env vars at service start; fail fast with a clear list of what's missing.
- Hermes never receives `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, or `DATABASE_URL`. These live only in the Node core / routing service.
- `NOUS_API_KEY` (primary) and `OPENROUTER_API_KEY` (fallback) are scoped to Hermes's own provider config (the NemoClaw-managed runtime), not exposed to MCP tools or the Node core. These are the credentials behind the Nemotron 3 Ultra reasoning calls and nothing else.
- `.env` is gitignored; commit `.env.example` with empty values only.

## 2. Agent capability model (NemoClaw)
Each agent role gets the minimum capability set. NemoClaw enforces tool access, network egress, credential access, financial actions, infra operations, and customer-data access per role.

| Role | May | May NOT |
|---|---|---|
| Monitoring | read fleet, read orders, create incidents | spend, payout, refund |
| Routing | driver/order locations, call cuOpt, propose assignments | payout, refund |
| Finance | read revenue, calc recovery cost, eval spend policy | exact customer addresses, modify routes |
| Operations | assign approved replacements, update delivery status, execute approved plans | exceed approved recovery budget |
| Payment | create approved payouts, issue approved refunds | spend > $20/incident without human approval |

**Auto spend cap:** `MAX_AUTOMATIC_INCIDENT_SPEND = 20`. Anything above requires explicit human approval and is logged as such.

## 3. MCP tool surface
- All 16 tools use typed parameters; every input Zod-validated; reject on any schema failure.
- Hermes never gets raw DB access and never generates SQL for execution.
- No tool executes arbitrary shell.
- All financial tools (`create_driver_payout`, `issue_customer_refund`, Stripe Projects provisioning) are **idempotent** — keyed so retries don't double-spend.

## 4. Stripe
- Webhooks: verify signature (`STRIPE_WEBHOOK_SECRET`) before any side effect. Unverified ⇒ 400, no work done.
- Webhook handlers idempotent on Stripe event id / payment intent id.
- Every Stripe write carries an idempotency key.
- Connect payouts and refunds only in test mode for the demo.

## 5. Financial integrity
- Every money movement passes a policy function *and* writes a `LEDGER` row in the same logical transaction.
- `POLICY_EVALUATIONS` records every requested action, amount, allowed/denied, reason.
- `AGENT_DECISIONS` records reasoning summary, options, selection, expected cost/benefit, policy result.
- Recovery plan selection optimises **expected net benefit**, never raw speed (see financial model).

## 6. Audit + human-in-the-loop
- Every consequential action writes an audit row before it's considered done.
- Destructive operations require human approval.
- The dashboard surfaces the policy panel so a human can see every allow/deny live.

## 7. Code hardening
- Strict TypeScript across all Node/TS packages.
- Zod at every trust boundary (HTTP in, MCP in, model out).
- Model output parsed as structured JSON and schema-validated before any action; unstructured text is never executed.

## 8. Determinism as a safety property
A fixed seed means the judged run is reproducible and reviewable. A non-deterministic financial demo is unauditable; determinism here is a security feature, not just a convenience.
