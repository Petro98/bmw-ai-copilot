# Execution map — running Plans 1–3 with parallel agents

Three plans implement the design (`docs/superpowers/specs/2026-11-13-bmw-ai-copilot-design.md`):

| Plan | Scope | Tasks |
|---|---|---|
| 1 — `2026-11-13-01-core-backend-panel.md` | phases 0–1: shared packages, backend, web panel, documents | 17 |
| 2 — `2026-11-13-02-car-app.md` | phases 2 and 4 as far as they can be built off the car | 9 |
| 3 — `2026-11-13-03-voice.md` | phase 3: push-to-talk in the browser | 4 |

Task ids below are `P<plan>-T<task>`.

## Waves

A wave starts only when the previous wave's gate is green. Inside a wave every stream runs at once; a stream written `A → B` is one agent doing the tasks in order.

| Wave | Streams (parallel) | Needs |
|---|---|---|
| 0 | `P1-T1` foundation and contracts | — |
| 1 | `P1-T2 → P1-T3` vehicle core · `P1-T4 → P1-T5` rules · `P1-T7` prompt · `P1-T8` Claude gateway · `P1-T9` cost guard · `P1-T10` stores · `P1-T14 → P1-T15` web panel · `P1-T17` documents · `P2-T1` kit and build chain | wave 0 |
| 2 | `P1-T6` Node 8 gate · `P1-T11` vehicle hub · `P2-T2` car provider · `P2-T3` power gate · `P2-T5` diagnostic gate · `P2-T6` uplink client · `P3-T2` speech adapters | wave 1 |
| 3 | `P1-T12` assistant service · `P2-T4` rules and pop-ups · `P2-T8` car screens | wave 2 |
| 4 | `P1-T13` HTTP API | wave 3 |
| 5 | `P1-T16` vertical slice, containers, README | wave 4 |
| 6 | `P2-T7` car link and access control · `P3-T1` sentence events · `P2-T9` car wiring and packaging | wave 5 |
| 7 | `P3-T3 → P3-T4` talk flow and installable app | wave 6 |
| 8 | whole-branch review, fixes, final gate | wave 7 |

Phase 1 is demonstrable after wave 5. Waves 6–7 finish the car app and voice. The longest chain is nine steps; the widest wave has nine streams.

## Rules that make the parallel waves safe

- **One working tree, disjoint files.** Each task owns the files in its **Files** block and touches no others. The only cross-task files are pre-written by `P1-T1` (root `package.json` with every script, `packages/ai-core/src/index.ts`) or edited in waves where no other stream touches them (`apps/backend/src/http/app.ts`, `.env.example`, `.github/workflows/ci.yml`, `README.md`).
- **No installs after wave 0.** `P1-T1` installs every root dependency, including esbuild. Exceptions, each isolated in its own directory: the Angular project (`P1-T14`) and its service-worker package (`P3-T4`). A task that discovers it needs something else reports it and stops.
- **Agents do not commit.** They run only their own task's tests and report the files they changed. After the wave's gate the orchestrator commits each task separately with the message its plan gives, then pushes the branch.
- **A contract bug is reported, not patched around.** If a task finds that a `P1-T1` contract is wrong, it stops and says so; the orchestrator fixes the contract and tells the affected streams.
- **Nothing reaches the car.** No agent runs anything against a head unit, a deploy repository or the Store. The on-car steps are written for the owner (`docs/CAR_CHECKLIST.md`, `docs/CAR_INSTALL.md`, `docs/VOICE_CAR_TEST.md`).

## Gate after every wave

```
npm run typecheck && npm run lint && npm test
npm run node8                                   # from wave 2
(cd apps/companion && npm test && npm run build) # from wave 1
npm run check:car                               # from wave 1
```

A red gate is fixed by an agent given the failing output and the owning task; the wave is re-gated before anything else starts. Evidence, not assertion: the orchestrator runs the commands itself and reads the output.

## Review (wave 8)

Four reviewers read the whole branch independently, each with one lens, and each finding is then challenged by a separate verifier before any fix is made:

1. **Spec and plan conformance** — every task's interfaces and decisions, the Review Focus lists.
2. **Safety** — read-only towards the vehicle, the forbidden references, no secret or car identity in the tree or in logs, the diagnostic gate has no caller.
3. **Head-unit fitness** — ES2017/Node 8, zero timers when parked, bounded buffers, write and network budgets, never-throw discipline.
4. **Backend and panel security and correctness** — sessions and device tokens, input validation, error mapping, SSE lifecycle, Claude request rules per model.

Confirmed findings are fixed, the gate is run again, and the branch is offered as a pull request into `main`.

## Models

Implementation and reading-heavy agents run on Opus; reviewers, verifiers and the orchestrator stay on the session model. This keeps the session model's weekly allowance for judgement rather than bulk. The owner can change it when launching.

## What only the owner can do

- Link a Claude Console organisation to the subscription and put an API key in `.env` (live mode; everything works in mock mode without it).
- Start Docker Desktop if the Compose run should be verified locally.
- Decide where the backend is hosted and set `OWNER_TOKEN` there.
- Create the car deploy repository, run `car/scripts/publish-car.mjs`, add it in the MGU Store, install the app, and work through `docs/CAR_CHECKLIST.md`.
- Try voice in the car with `docs/VOICE_CAR_TEST.md`.
