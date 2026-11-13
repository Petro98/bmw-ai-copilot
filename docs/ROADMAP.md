# Roadmap

Six phases, from research to optional extras. Each phase has an exit criterion that is checked,
not assumed. Phases 0–3 can be built and tested without the car; everything that needs the car
is done by the owner with `docs/CAR_CHECKLIST.md` (and, later, `docs/CAR_INSTALL.md` and
`docs/VOICE_CAR_TEST.md`).

Implementation plans: `docs/superpowers/plans/` (Plan 1: phases 0–1; Plan 2: phases 2 and 4 as far
as they can be built off the car; Plan 3: phase 3). The order in which their tasks run is in
`2026-11-13-00-execution-map.md`.

| Phase | Name | Needs the car | Plan |
|---|---|---|---|
| 0 | Research and architecture | no | spec, Plan 1 Task 17 |
| 1 | Working MVP without a car | no | Plan 1 |
| 2 | Car integration (read-only) | yes, for the exit | Plan 2 |
| 3 | Voice | yes, for the exit | Plan 3 |
| 4 | Background assistant | yes, for the exit | Plan 2 (built), car checks (proved) |
| 5 | Advanced | partly | not planned yet |

## Phase 0 — research and architecture

Ten research reports and pinned copies of the reference repositories (local, not committed), the
design spec, and four documents: `ARCHITECTURE.md`, `ROADMAP.md`, `COMPATIBILITY.md` (verified
facts, hypotheses, excluded items) and `CAR_CHECKLIST.md`.

**Exit:** the owner approves the design spec and these four documents.

## Phase 1 — working MVP without a car

Shared packages (vehicle model, signal catalogue, mock vehicle, rules), Claude service with
budgets, dialog history, rule-based alerts, the local web panel, configuration from environment
variables, unit and integration tests, Docker Compose, README.

**Exit:** `mock telemetry → event engine → Claude → response → panel` is demonstrated locally,
both with an API key (live) and without one (mock mode); type checks, lint and all tests are
green; the shared packages pass on Node 8.16.2 (in CI).

## Phase 2 — car integration (read-only)

The car app with real passive telemetry, a Ukrainian screen, pairing with the backend, the
uplink client, and the MGU Store package. Device tokens and owner sessions in the backend.

**Exit:** installed by the owner through the Store; shows live values that match the cluster;
answers a question on the iDrive screen; its own resource figures are within the budgets in
`ARCHITECTURE.md`.

## Phase 3 — voice

Push-to-talk on the phone with the browser's own Ukrainian speech recognition and synthesis
(free path, Chrome on Android), sentence-by-sentence speech of streamed answers, installable web
app. Cloud speech providers can be added later behind the same adapters.

**Exit:** a push-to-talk Ukrainian question is answered aloud through the car's speakers via the
phone.

## Phase 4 — background assistant

Autostart, local rules, BMW pop-ups, alert history and power gating in the car app (built in
Plan 2; proved on the car).

**Exit:** a deliberately triggered harmless Check Control message produces exactly one correct
pop-up with the app's screen closed; head-unit shutdown time and overnight 12 V are unchanged with
the app installed.

## Phase 5 — advanced

Maintenance advice, trip and long-term trends, optional read-only diagnostic extras (only after
the owner's separate approval of the diagnostic car checks), an optional wake word in a native
phone wrapper.

**Exit:** set per feature when the phase is planned.

## Open owner decisions

None of these blocks phase 1.

| # | Decision | Needed before | Notes |
|---|---|---|---|
| 1 | Confirm the car: X3 xDrive30i, model year 2021, North-American specification, 2.0-litre four-cylinder petrol, 8-speed automatic, all-wheel drive. | phase 2 | Derived from the owner's data; units (°F, psi, miles) and the engine family matter for the signal catalogue. |
| 2 | Approve the design spec and the phase 0 documents. | end of phase 0 | |
| 3 | Model for the spoken route: stay on `claude-opus-5-5` or use a faster model (`claude-haiku-5-5`) after measuring latency. | phase 3 | `CLAUDE_MODEL_VOICE` setting. |
| 4 | Where the backend is hosted for real use, and its `OWNER_TOKEN`. | phase 2 | Phase 1 runs on the owner's laptop. |
| 5 | Repository public or private; with that, how the car learns the backend address (end-to-end-encrypted rendezvous during pairing, or a configuration file in a private Store source). | start of phase 2 | The backend address is never committed to a public repository. |
| 6 | Link a Claude Console organisation to the subscription for the included API credits; create a key in its own workspace with a spend limit. | live mode | Mock mode works without it. |
| 7 | Whether to approve the on-car diagnostic checks (one read-only fault-memory read, unit identification). Until then diagnostics stay disabled. | phase 5 extras | Checklist section C. |
| 8 | Whether to approve the phone-voice audio checks in the car. | phase 3 exit | Checklist section C. |
| 9 | What to do about write-capable community apps or tools already installed on the head unit (if the inventory finds any). | phase 2 | The project's own code never writes; removing others is the owner's call. |
| 10 | Procedure with the service station before and after a BMW software update (Store setup removed by the update; re-installation needs root access the owner does not hold). | before any BMW update | Checklist item A2. |

Decided on 2026-11-13: approach A (own code, reuse of MIT code allowed); Android with Android
Auto; Store installed by a service station, no root key; free browser speech preferred; MIT licence
for our code.

Revisited only on the owner's explicit request: sound from the head unit itself, head-up display
or cluster output, a root tool on the head unit.
