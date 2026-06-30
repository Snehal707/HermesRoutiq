# Cursor Prompt — Phase 2: City Map + Deterministic Simulator

Paste this whole thing into Cursor as one prompt.

---

You are working in the `hermes-routiq` repo. Read `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, and `README.md` first — they define the project contract. This prompt is Phase 2 only.

## Goal
A Next.js app that renders a 2.5D city map with 8 simulated drivers moving along deterministic seeded routes, pickup hubs, customer destinations, working sim controls, and a breakdown button. **No database, no Hermes, no Stripe, no real cuOpt call.** Everything in-memory, in the browser, for this phase.

## Files to create
- `apps/web/package.json`, `tsconfig.json`, `tailwind.config.ts`, `next.config.js` — standard Next.js (App Router) + TypeScript + Tailwind scaffold.
- `apps/web/app/layout.tsx`, `apps/web/app/page.tsx` — root layout and the single dashboard page.
- `apps/web/lib/prng.ts` — a seeded PRNG (mulberry32 or similar). Export a function `createRng(seed: number): () => number`. This is the ONLY source of randomness allowed anywhere in the simulator. No `Math.random()` calls anywhere in `lib/sim/`.
- `apps/web/lib/sim/world.ts` — builds the seeded world state: 8 drivers, 8 vehicles, 2 pickup hubs, 10 customer locations, 4 active orders, with exactly 3 of those orders assigned to one specific vehicle (the one that will break down). Use `SIMULATION_SEED` (default 42) from env, read via `process.env.NEXT_PUBLIC_SIMULATION_SEED` with a fallback constant.
- `apps/web/lib/sim/movement.ts` — deterministic interpolation: given a route (array of lat/lng waypoints) and elapsed sim time, compute current position. Pure function, no side effects, fully testable.
- `apps/web/lib/sim/clock.ts` — a tick loop class/hook: `start()`, `pause()`, `reset()`, `setSpeed(multiplier)`. Drives movement.ts on each tick.
- `apps/web/lib/sim/types.ts` — re-export or define the shared types (or pull from `packages/shared/types` if you create them there instead — your call, but keep one source of truth).
- `apps/web/components/CityMap.tsx` — MapLibre GL JS map with 3D building extrusion, plus a deck.gl `TripsLayer` overlay rendering driver routes. Use a free style URL for now: `https://demotiles.maplibre.org/style.json` (read from `NEXT_PUBLIC_MAP_STYLE_URL` env var, fallback to that demo URL if unset).
- `apps/web/components/SimControls.tsx` — Start / Pause / Reset / Speed buttons, plus a distinct **"Simulate Breakdown"** button.
- `apps/web/components/Legend.tsx` — color key: green = normal route, yellow = at risk, red = incident, blue = recovery route, grey = completed.
- `packages/shared/types/index.ts` — shared TypeScript types: `Driver`, `Vehicle`, `Order`, `Incident`, route/status enums. These will be reused by later services, so keep them framework-agnostic (no Next.js or React imports here).

## Behavior requirements
1. Map renders with 3D buildings visible.
2. 8 drivers appear as markers and visibly move along their predefined routes once simulation is started.
3. 2 pickup hubs and 10 customer destinations render as distinct marker types.
4. Start / Pause / Reset / Speed controls all work and visibly affect movement.
5. Clicking "Simulate Breakdown" stops the target vehicle (the one carrying 3 orders) and turns it and its route red. This is a pure client-side state change for now — no backend call.
6. Reloading the page with the same seed produces identical initial driver positions and routes every time. Verify this by hardcoding the seed and confirming no `Math.random()` appears anywhere in `lib/sim/`.

## Explicit non-goals for this phase
Do not add: Postgres, Redis, Stripe, MCP server, Hermes, Nemotron, NemoClaw, real cuOpt calls, custom 3D vehicle models. Use simple markers. Use hardcoded/precomputed polylines for routes instead of a real routing call — this is what `MockRoutingProvider` will formalize in Phase 5, but don't build that abstraction yet, just inline the precomputed routes in `world.ts` for now.

## Process
1. State which files you're creating/changing before writing code, in small batches — not all at once.
2. After scaffolding, run the dev server and confirm it boots with no errors.
3. Run lint and typecheck after each batch of files.
4. Stop and summarize what's working and what isn't after this phase — do not proceed into Phase 3 work (Postgres/Redis) without explicit go-ahead.

## Hard rules (apply for the whole project, not just this phase)
- Never run a recursive delete near `.git` or any config file without asking first.
- Never commit `.env` (only `.env.example`).
- Strict TypeScript, no `any` without a comment justifying it.
- Stop and ask before any destructive or irreversible operation.
