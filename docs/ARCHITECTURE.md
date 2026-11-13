# Architecture

BMW AI Copilot is a personal, strictly read-only assistant for one car: a BMW X3 xDrive30i, model
year 2021 (to be confirmed by the owner; North-American specification assumed,
`docs/COMPATIBILITY.md` H-1), with an MGU head unit (iDrive 7). The owner asks about the car in
Ukrainian and gets Ukrainian answers grounded in the car's own data; the assistant also watches
the car and relays BMW's own warnings.

This document is the summary of the design. The full reasoning is in
`docs/superpowers/specs/2026-11-13-bmw-ai-copilot-design.md`; what is and is not known about the
car is in `docs/COMPATIBILITY.md`.

Two requirements rank above every feature:

1. **Read-only towards the vehicle.** The system reads, analyses, recommends and warns. It never
   controls, codes, writes, clears or suppresses anything.
2. **Minimal footprint on the head unit.** Everything in the car uses as little CPU, memory,
   flash writes, network and 12 V energy as possible.

## Components

```
            phone (companion web app)                    owner-hosted backend (Node 22, TypeScript)
   ┌──────────────────────────────────┐        ┌──────────────────────────────────────────────────┐
   │ push-to-talk, dialog, sensors,   │ HTTPS  │ API (REST + server-sent events)                  │
   │ alerts, settings, status         │◄──────►│ Claude service (official SDK, streaming, budgets)│
   │ speech in/out ─► car speakers via│        │ history store (SQLite)                           │
   │ Android Auto / Bluetooth audio   │        │ event engine (shared rules)                      │
   └──────────────────────────────────┘        │ vehicle data: mock provider | car-link provider  │
                                               └───────────────▲──────────────────────────────────┘
                                                               │ outbound HTTPS only, device token
   head unit (MGU, Node 8.16.2)                                │
   ┌───────────────────────────────────────────────────────────┴───┐
   │ car app (one autostart process)                               │
   │  passive signal reader ─► local rule engine ─► BMW pop-up     │
   │  power gate (vehicle condition)                               │
   │  compact snapshot upload (≤ 1/min while driving, when online) │
   │  minimal Ukrainian screen, drawn only while visible           │
   └───────────────────────────────────────────────────────────────┘
```

| Component | Where it runs | What it is |
|---|---|---|
| `packages/vehicle-core` | backend and head unit | The vehicle model (`Reading<T>`, `VehicleSnapshot`), the `VehicleDataProvider` interface, the signal catalogue with scalings and invalid values (each entry cites its source), and the mock provider with scripted scenarios. Zero runtime dependencies, compiled to ES2017 CommonJS, tested on Node 8.16.2. |
| `packages/event-engine` | backend and head unit | Alert rules and the engine that evaluates them over snapshots: dwell, hysteresis, cooldown, de-duplication, global rate limit, suppression while reversing, bounded history. No timers or clocks of its own. Same Node 8 constraints. |
| `packages/shared` | backend, phone and head unit | API data contracts (DTOs) for the backend and the companion, and the car link's contracts and constants (`car-dto.ts`), which the car bundle takes in. The request schemas (Zod) live in the backend (`apps/backend/src/http/schemas.ts` and the feature routes). |
| `packages/ai-core` | backend | Prompt construction (frozen Ukrainian instructions, then the volatile snapshot and dialog), the Claude gateway around the official SDK with typed errors, a mock gateway, and the cost guard. |
| `apps/backend` | owner's server or laptop | Fastify API on Node 22: dialog, live state over server-sent events, settings, health, metrics, mock scenarios, and (phase 2) the car link and owner sessions. SQLite for dialog turns, alert events and telemetry samples. |
| `apps/companion` | phone browser | Angular web app, mobile-first and dark: assistant, car (sensor tiles and alerts), settings; phase 3 adds push-to-talk with the browser's own speech. |
| `car/` | head unit | The car app: TypeScript bundled into one ES2017 CommonJS file, loaded by the vendored MIT app kit on the head unit's Node 8, packaged for the MGU Store. |

### Division of labour

| Concern | Car app | Backend | Phone |
|---|---|---|---|
| Read signals | ✔ | | |
| Detect alert conditions | ✔ (works offline) | the same rules, for the mock vehicle and analysis | |
| Show an alert in the car | ✔ BMW pop-up and screen | | optional spoken version |
| Claude calls, API key | | ✔ | |
| Speech recognition and synthesis | | text in, text out | ✔ microphone, speaker (browser speech) |
| History and trends | RAM ring buffer only | ✔ SQLite | |
| Settings | a few, on the iDrive screen | ✔ source of truth | ✔ user interface |

Key decisions:

- No API key and no long-term history on the head unit. The car holds only a device token.
- The car only makes outbound HTTPS requests: no listener, no firewall change, no root tool.
- Alert detection is local and needs no internet. Claude's explanation is an optional extra.
- One process in the car: no daemon, no Node 22, no Python.
- Rules and signal decoding are shared, dependency-free code tested on Node 8.

## Data flows

### A question

1. The owner asks in the companion (typed, a topic chip, or in phase 3 by voice: the browser
   recognises `uk-UA` speech and sends text), or on the iDrive screen with a topic chip.
2. The companion sends `POST /api/ask/stream` (`{ text, style, source }`); the car app sends
   `POST /car/v1/ask` with its device token. A question tapped on the car while it is not
   driving first sends the current snapshot alone to `POST /car/v1/snapshots`, so it is answered
   from the readings of now; a question asked on the phone while the engine is off is answered
   from the car's last upload, with its age.
3. The backend validates the question (1–500 characters) and checks the cost guard (daily and
   monthly budget, request rate). A budget that is exhausted answers at once with a Ukrainian
   message and nothing is sent to Claude. A question in flight reserves its worst-case output
   cost against both budgets until it ends.
4. The prompt builder assembles: the frozen Ukrainian instructions (cache breakpoint), then the
   current snapshot with each value's age and provenance, the values that are unavailable named
   as unavailable, the newest 20 active alerts, each with its provenance and when it appeared
   (the rest only counted), the owner's limits labelled as the owner's, a short trend summary,
   and the last dialog turns (only those since the current vehicle source began writing to the database).
   When the backend runs the mock vehicle (or any reading comes from it), a line tells Claude the data is
   demonstration data and that it must say so. Vehicle text (Check Control) is presented as data, never as
   instructions. While the car moves the prompt asks for at most three short sentences
   (≤ 45 words); standing, at most eight (≤ 160 words). Motion counts only from a speed reading
   at most two minutes old. A car that has sent nothing for longer is described as not
   reporting, with the age of its last data; it keeps the short rule when its last speed was
   moving and that data is at most 15 minutes old, and gets the standing length otherwise. Any
   other unknown motion keeps the short rule.
5. The Claude gateway calls the Messages API through the official SDK: model from configuration
   (default `claude-opus-5-5`), adaptive thinking, explicit effort, streaming; `stop_reason` is
   checked before content; errors map to one clear Ukrainian message and are never retried in a
   loop.
6. Text deltas stream back as server-sent events (`delta`, then `done` with the stored turn; in
   phase 3 also whole `sentence` events so the phone can start speaking early). The turn is
   stored only when the answer completed; an answer cut off by `max_tokens` is not stored (the
   user gets the error message). Usage is added to the budget, and an answer interrupted or timed
   out after streaming began is added by a conservative estimate.
7. The phone shows the answer and, for a spoken question, speaks it through Android Auto or
   Bluetooth audio. The car app shows the turn on its screen.

### An alert

1. In the car, BMW raises a Check Control message (the cluster shows it as usual). The car app
   receives it passively from `CheckControlMaster.basicList` and its text from
   `KombiInterface_2.ccList`.
2. The car app's 1 Hz rule tick (only while the ignition is on) runs the shared event engine:
   the `bmw-check-control` rule produces a candidate with the car's own text (or "BMW Check
   Control message <id>" when no text arrived) and the car's colour as severity. Dwell, cooldown,
   de-duplication and the global rate limit decide whether it is raised.
3. A raised `critical` or `warning` event becomes one BMW small pop-up after a short settle
   delay, so BMW's own message appears first; it closes by itself; none is shown while reversing;
   a setting turns pop-ups off. `info` events go to the list only.
4. When online, the car app posts the event to `POST /car/v1/alerts`; otherwise it keeps a
   bounded number for the next successful send, also across a restart of the app (at most 20
   kept in its state file). The backend stores a new event; for an id seen before it records
   only a change of state (a clearing or a return) and ignores a repeat. It publishes the event on
   `GET /api/events`; the companion shows it. Removing the paired device on the phone clears
   every active alert the car had reported; the car reports its standing alerts again on its
   next start.
5. If the owner then asks "what happened?", the question flow above explains it with Claude.

Rule provenances: `bmw-check-control`, `bmw-fault-status`, `bmw-service` (enabled) and
`owner-configured` (shipped disabled with empty limits). No rule has a built-in numeric
threshold.

In phase 1 the same flow runs entirely in the backend: the mock provider plays a scenario, the
backend's event engine raises the alert, and the panel shows it.

### A telemetry sample

1. The car app subscribes once per interface to the passive fields it needs; handlers only
   store the latest raw value. Fields that never notify (tyre pressures, fuel, range, odometer)
   are polled no faster than every 10 seconds.
2. Decoding applies the catalogue's scaling, invalid sentinels and the car's own units, and
   produces a `VehicleSnapshot` in which every value is a `Reading<T>`: available (value, unit,
   source, time received) or unavailable with a reason. Nothing is defaulted, estimated or
   turned into `0`.
3. The power gate reads the vehicle condition: parked or standby → asleep (none of the app's
   timers, no network, no diagnostics; the kit's screen loop and renderer keep-alive follow the
   screen's visibility, not the power gate); ignition on → awake (1 Hz tick, network only for an
   alert or a question, the config fetch once per wake, and while the screen shows the dialog
   long poll); driving → also the snapshot upload. With the condition unknown or stale and no
   passive signal for 15 minutes, the gate falls asleep too (not while the pairing panel is on
   screen); a question, the screen being shown, or a condition notification wakes it.
4. While driving, snapshots go into a RAM ring buffer, and at most once a minute one batch is
   posted to `POST /car/v1/snapshots` when the uplink is online. Every batch carries `sentAt`,
   the car's clock when it is sent (stamped again on a resend). A batch that fails stays in the
   buffer (bounded) for the next interval; there are no retries in between. A batch the backend
   refuses with a 4xx other than 401/403 is tried once more, then dropped, and does not hold up
   alerts; a 401/403 stops all sending with that device until it is paired again or the app wakes.
5. The backend's car-link provider ingests the batch; when `sentAt` shows the car's clock off by
   more than two minutes, it moves the reading and alert times onto its own clock. The vehicle
   hub publishes the latest snapshot on `GET /api/events` and stores one telemetry sample a
   minute with daily roll-ups and retention limits. The provider reports the car as disconnected
   three minutes after the last batch. With the mock vehicle source the backend refuses the car's
   snapshots, alerts, questions and dialog requests with a 404 naming `VEHICLE_SOURCE=car`.

## Safety model

| Rule | How it is enforced |
|---|---|
| Never write to the vehicle | The car app declares no signal with the write flag, never calls the kit's `signals.set`, never calls a method on a vehicle interface, and never references `WakeUpOnDemand`, `WodControl` or `RegisterShutdownClient`. The kit's build still declares these and other platform interfaces in the package manifest, as BMW's apps do; neither the kit's runtime nor our code calls them, whether BMW's SDK does is not known, and whether they can be removed without breaking the app's start is open (`docs/COMPATIBILITY.md` H-27, car check B18). No backend or phone path talks to the vehicle at all. |
| Diagnostics are read-only and off | A diagnostic gate with an allow-list (`0x22`, OBD `01`/`09`, and to all units exactly `22 F1 50`, `19 02 <mask>`, `19 17 <mask> 01`) is unit-tested to refuse sessions, resets, clearing, security access, writes, routines, downloads, tester present and DTC settings. It ships disabled and nothing constructs it with a real transport until the owner separately approves the on-car diagnostic checks. Claude never chooses services or identifiers. |
| Never keep the car awake | Passive signals only; none of the app's timers and no network while parked (the kit's screen loop and renderer keep-alive follow the screen's visibility, so they run for as long as the head unit reports the app's screen shown: car check B15); no diagnostic request while parked, starting, stopping or cranking. The app stays registered ACTIVE with MainApp for its whole life (`ctx.background('monitor', true)`); whether that changes when the unit sleeps is car check B16. |
| Never hide or replace BMW warnings | BMW's message comes first; our pop-up follows after a settle delay and can be switched off. The kit exposes no pop-up priority, so whether BMW's messages always win is car check B11. No head-up display, cluster or audio output. |
| No invented numbers | Every value carries its provenance and age; missing values are named as unavailable; no rule has a numeric default; the prompt separates car data, the owner's limits and labelled general knowledge. An opt-in evaluation script flags answers with car-style numbers absent from the snapshot. |
| Secrets and identity | The API key lives only in the backend's environment and never reaches a log, an error or a response. The car holds a device token; the backend stores only its hash. The vehicle identification number is never stored or sent; at most characters 1–11 could ever be sent. No backend address in a public repository. |
| Nothing reaches the car without the owner | The project installs nothing on the car. Every on-car step is written for the owner (`docs/CAR_CHECKLIST.md`, `docs/CAR_INSTALL.md`) and done by him. |
| Never crash in the car | Every timer, handler and promise goes through one wrapper that logs and carries on; no `process.exit`; bounded buffers; small atomic writes. After a crash BMW's app manager restarts the app, and without the Store's patch it wipes the app's data or uninstalls it. |

## Resource budgets for the head unit

Targets, to be confirmed or tightened by measurement on the car; the app reports its own figures.

| Resource | Budget |
|---|---|
| Processes | 1 (Node 8), no daemon |
| Memory | declared cap 128 MiB (`memoryKB` 131072), target steady RSS ≤ 60 MB, zero growth over a drive |
| CPU | declared `cpuLimit` 30; hidden: one 1 Hz tick plus event handlers; parked: none of the app's timers (the kit's screen loop follows the screen's visibility) |
| Rendering | only while visible, on change, ≤ 4 fps; never the software PNG path above 1 fps; no home-screen widget |
| Storage writes | no telemetry history on flash; small atomic state writes only when something in the state changed: on sleep, on pairing and settings changes, at once for a raised `critical` or `warning` alert (bounded by the engine's global rate limit), and at most once a minute for clearings; log ≤ 256 KB with one rotation |
| Network | driving: one snapshot batch a minute, plus each raised alert and each question; awake: the config fetch once per wake, alerts and questions (a question tapped while not driving first sends the current snapshot); screen shown: one long poll for answers asked on the phone, and with the pairing panel one retry every 30 s; a failed dialog poll or config fetch backs off up to 10 minutes; failed alert and snapshot sends are tried again at most once a minute; parked: none; no probes |
| Diagnostics | none in the background by default |
| 12 V | no measurable change in head-unit shutdown time or overnight voltage with the app installed |

Backend and phone budgets: answers have a per-request `max_tokens`, daily and monthly USD budgets
computed from the API's usage figures, and a request rate limit. Stores and streams are bounded:
the newest 1000 dialog turns, the newest 1000 cleared alert events (active ones are kept), spend
rows for the current and previous month, raw telemetry samples for `TELEMETRY_RETENTION_DAYS`
(daily roll-ups are kept), and at most 20 open `GET /api/events` streams.

## Repository layout

```
apps/backend/          Node 22 API, Claude service, stores
apps/companion/        Angular web app (phase 1: local web panel; phase 3: voice)
packages/shared/       API contracts
packages/vehicle-core/ provider interface, signal catalogue, mock provider   (Node 8-safe)
packages/event-engine/ rules engine                                          (Node 8-safe)
packages/ai-core/      prompts, Claude gateway, cost guard
car/                   car app sources, vendored MIT kit, Store manifest (phase 2)
scripts/               Node 8 runner and smoke test, opt-in Claude evaluation
docs/                  this document, ROADMAP.md, COMPATIBILITY.md, CAR_CHECKLIST.md,
                       design/ (language, tokens, mock-ups), superpowers/ (spec and plans)
```

npm workspaces, strict TypeScript, Vitest, ESLint. Licence MIT for our code; vendored MIT code
keeps its notice; GPL projects are read for behaviour only and never copied. BMW's SDK is never
in the repository. `.research/`, `.env`, databases and build output are never committed.

### Main HTTP routes

| Route | Purpose |
|---|---|
| `GET /api/health`, `GET /api/status`, `GET /api/metrics` | liveness, versions and modes, process figures |
| `GET /api/snapshot`, `GET /api/alerts`, `GET /api/dialog` | current state and recent history |
| `POST /api/ask`, `POST /api/ask/stream` | a question, whole or streamed |
| `GET /api/events` | live snapshots, alerts and status |
| `GET`/`PUT /api/settings` | owner limits, pop-ups, diagnostics switch (stays off: `PUT` refuses `true` with 400) |
| `GET /api/mock/scenarios`, `POST /api/mock/scenario` | demo scenarios (mock vehicle only) |
| `/car/v1/snapshots`, `/car/v1/alerts`, `/car/v1/ask`, `/car/v1/dialog`, `/car/v1/config` | the car link (phase 2), device-token authentication |
| `/api/session`, `/api/devices` | owner session and paired devices (phase 2) |

The exact contracts are in Plan 1 Task 1 and Plan 2 Task 7 under `docs/superpowers/plans/`.
