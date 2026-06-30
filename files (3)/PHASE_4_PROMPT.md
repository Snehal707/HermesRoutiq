# Cursor Prompt — Phase 4: Stripe Checkout Sandbox + Webhooks

Paste this after Phase 3 is confirmed working (refresh survives reload).

---

You are working in the `hermes-routiq` repo. Read `docs/SECURITY_POLICY.md` section on Stripe before starting — webhook signature verification and idempotency are non-negotiable, not nice-to-haves.

## Goal
A customer can create a $14 delivery order, pay through Stripe Checkout sandbox, and a verified webhook creates the paid order in Postgres. The order only appears on the map after the webhook succeeds — never optimistically before that.

## Prerequisite — tell the user, don't guess
`STRIPE_WEBHOOK_SECRET` cannot be obtained until a webhook endpoint exists and is registered with Stripe (either via the Stripe CLI for local dev, `stripe listen --forward-to localhost:3000/api/stripe/webhook`, or via the Stripe dashboard once deployed). If this is local dev, the user needs to install the Stripe CLI and run `stripe listen` to get a local-mode webhook secret. Tell the user this explicitly rather than leaving `STRIPE_WEBHOOK_SECRET` blank and silently skipping verification.

## Files to create
- `apps/web/app/api/checkout/route.ts` — POST endpoint, creates a Stripe Checkout Session for a $14 delivery order (server-side, uses `STRIPE_SECRET_KEY`). Returns the session URL/ID to redirect the customer to.
- `apps/web/app/api/stripe/webhook/route.ts` — POST endpoint. Verifies the Stripe signature using `STRIPE_WEBHOOK_SECRET` before doing ANY work. On `checkout.session.completed`, idempotently create the order in Postgres (use the Stripe event ID or payment_intent ID as the idempotency key — check if an order with that reference already exists before inserting).
- `apps/web/components/CreateDeliveryButton.tsx` — UI trigger that calls `/api/checkout` and redirects to Stripe Checkout.
- `apps/web/lib/stripe/server.ts` — server-only Stripe SDK client.
- Update the dashboard so the new paid order appears on the map only once it exists in Postgres with `status = 'paid'` — driven by the webhook, not by the client-side checkout redirect alone.

## Behavior requirements
1. Clicking "Create Delivery" opens Stripe Checkout (sandbox/test mode) for $14.
2. Completing payment with a Stripe test card (4242 4242 4242 4242) redirects back, and shortly after, the webhook fires and the order appears on the map.
3. Manually replaying the same webhook event (Stripe CLI supports `stripe trigger checkout.session.completed` or resending from the dashboard) must NOT create a duplicate order. Test this explicitly.
4. An unsigned or badly-signed request to `/api/stripe/webhook` is rejected with 400 and does no database writes. Test this explicitly (e.g. curl with no signature header).
5. No order appears on the map purely from the client-side redirect — only after the webhook-driven Postgres write.

## Explicit non-goals for this phase
No Connect payouts yet (that's Phase 9). No cuOpt assignment logic changes — wiring the paid order into routing assignment can be a thin follow-up once this phase's webhook flow is solid, but don't conflate the two in one giant change.

## Process
1. State file changes in small batches before writing.
2. Walk the user through starting `stripe listen` locally before testing, if not already running.
3. Test the full payment flow live with a test card, not just unit tests of the handler logic in isolation.
4. Test the duplicate-webhook and bad-signature cases explicitly — these are the two failure modes the security policy calls out by name.
5. Lint + typecheck after each batch.
6. Stop after this phase's gate passes. Do not start Phase 5 (routing/cuOpt) without explicit go-ahead.

## Hard rules
- Never log or print the full `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` to console, even in dev.
- Every Stripe write must carry an idempotency key.
- Webhook handler must verify signature before any side effect — no exceptions, not even "just for local testing."
- Never commit `.env` or `.env.local`.
