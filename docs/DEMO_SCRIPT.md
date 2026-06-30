# HermesRoutiq — Demo Script

A tight, reproducible run. Fixed seed. Target: full sequence, 0 human interventions, 0 policy violations, recovery in under ~60s.

## Pre-flight
- All services up: web, Node core (sim/MCP/WS), routing (cuOpt), Hermes-in-NemoClaw.
- `.env` populated with real `NEMOTRON_MODEL_ID`, `CUOPT_API_URL`, Stripe sandbox keys, `SIMULATION_SEED` set.
- Dashboard open on the operations view.

## Live sequence
1. Open the HermesRoutiq operations dashboard.
2. Eight drivers visibly moving across the 2.5D city map.
3. Show business wallet, active deliveries, expected profit.
4. Create a new $14 delivery order.
5. Complete the Stripe sandbox payment (test card).
6. Verified Stripe webhook fires.
7. Paid delivery appears on the map.
8. cuOpt assigns the best driver and route.
9. Delivery starts; driver moves.
10. Press Simulate Breakdown on the vehicle carrying 3 orders.
11. Vehicle stops, flashes red; route turns red.
12. Dashboard shows affected deliveries (3) and revenue at risk.
13. Incident sent to Hermes via MCP.
14. Nemotron 3 Ultra compares recovery strategies (1 driver / 2 drivers / wait).
15. Hermes reasons inside NemoClaw, while our MCP policy layer validates permitted business tools and budget.
16. cuOpt calculates replacement routes.
17. Hermes selects two replacement drivers (best expected net benefit).
18. Stripe Connect sandbox creates the two test payouts.
19. New routes render in blue.
20. Replacement drivers complete the recovered deliveries.
21. Verify customer outcomes.
22. Record the financial result.
23. Hermes creates/updates the vehicle_breakdown_recovery skill.
24. Display the final recovery report.

## Expected final screen
Affected deliveries:            3
Recovered deliveries:           3
Customer revenue protected:   $42
Emergency spending:           $11
Refunds avoided:              $18
Estimated churn loss avoided: $12
Net financial benefit:        $19
Human intervention:             0
Policy violations:              0
Recovery time:               58 s
New Hermes skill created: vehicle_breakdown_recovery

## Financial model shown on the decision panel
Expected loss (no action) = refunds $18 + churn $12 = $30 avoided
Recovery cost = replacement drivers $8 + emergency premium $3 = $11
Expected net benefit = $30 − $11 = $19

Three options compared:
- One replacement: +$5, 1 late delivery
- Two replacements: +$9, 0 late deliveries ← selected
- Wait for original: +$0, 3 late deliveries

## Optional flourish (if time)
Trigger rising event volume → Hermes evaluates infra need → application policy approves → Stripe Projects pattern provisions inngest/app → expense ledgered.

## Failure recovery during demo
If a surface flickers: routing can fall back to MockRoutingProvider, sim is deterministic, reset + replay reproduces exact run. Keep seed 42 handy.
