# BMW AI Copilot — design

Date: 2026-11-13 · Status: awaiting owner approval

## 1. Intent

A personal AI assistant for the owner's own car (BMW X3 G01, 2021, MGU head unit / iDrive 7,
firmware `P18_23w44.2-1-3`). The owner asks about the car by voice in Ukrainian and hears a
spoken answer; the assistant watches live telemetry while driving and warns about problems even
when its screen is closed; it explains faults, service items and trends using Claude.

Why: the owner wants something that feels like a native part of the car, not a chat demo, and
that he can extend himself (he is an Angular / Node.js / TypeScript developer).

Two requirements rank above every feature:

1. **Strictly read-only towards the vehicle.** The system analyses, recommends and warns. It
   never controls, codes, writes, clears or suppresses anything.
2. **Minimal footprint on the head unit.** Everything that runs in the car must use as little
   CPU, RAM, storage writes, network and 12 V energy as possible.

## 2. Goals, non-goals, anti-goals

Goals

- G1. Voice question in Ukrainian → spoken Ukrainian answer grounded in the car's real data.
- G2. Proactive warnings while driving, without the assistant's screen being open.
- G3. Read-only telemetry, fault memory and service data as context for Claude.
- G4. History and trends over weeks.
- G5. A native iDrive 7 screen (dark, glanceable) plus a phone companion.
- G6. Runs and is fully testable locally without a car (mock vehicle).

Non-goals (this design)

- Using the car's cabin microphone or BMW's speech engine (no access path exists — §4).
- Playing sound from the head unit itself (possible only through state-changing calls into
  BMW's audio manager — excluded by requirement 1; revisit only on explicit owner request).
- Taking over the steering-wheel voice button (BMW's assistant always reacts to it too).
- Head-up display or instrument-cluster output (a community experiment restarted a cluster and
  raised brake/ABS warnings).
- A wake word (later, optional, native phone wrapper only).

Anti-goals — the project has failed if any of these happen, even if features work

- Any diagnostic write, session change, fault clearing, coding change, or actuator command.
- The car or head unit is kept awake, or the 12 V battery is drained, by our software.
- A BMW warning is hidden, delayed or replaced by ours.
- The assistant states a number, limit or signal that the car did not report or that has no
  stated provenance.
- An API key, the full VIN, or anything identifying the car lands in git or logs.
- Anything is installed on the real car without the owner's explicit confirmation each time.

## 3. Approaches considered

**A. Thin car app + backend brain (chosen; confirmed by the owner on 2026-11-13: "our own code,
but we may look at other developers' solutions and take ready-made parts").**
Reuse policy that follows: MIT-licensed code (the `idrive7-apps` kit, `JustAnotherPU/mgu-apps`)
may be copied with its notice; GPL-licensed projects (M-Copilot, `mgu-store`) are used as
documentation of behaviour and re-implemented, because copying their code would put this
repository under GPL-3.0 — the owner can lift that restriction by choosing GPL.
The head unit runs one small autostart app that only reads signals, evaluates local rules,
shows pop-ups and a minimal screen. Claude, speech, history and analytics live in a backend the
owner hosts; the phone companion does the voice I/O. New code, based on the MIT-licensed app kit.
Trade-off: most new code (pairing, uplink DNS, TLS on Node 8 must be re-implemented) and a
backend to host, in exchange for the smallest head-unit footprint, licence freedom, modern
TypeScript everywhere except a thin Node 8 layer, and a design that is useful before the car
part exists.

**B. Fork M-Copilot (`hexlay/idrive7-custom-apps`, GPL-3.0-or-later).**
An existing iDrive 7 AI co-driver that already calls Claude from the head unit with live data.
Fastest route to an in-car text assistant (research estimate 25–37 engineer-days for all goals
versus 38–55 for A). Trade-off: the whole project becomes GPL-3.0 (the repository is public),
Claude calls, the API key and all history sit on the head unit (more CPU/RAM/flash writes — against
requirement 2), its `main.js` is a single 1,569-line closure with no tests for the AI path, and
its diagnostics have no enforced read-only gate.

**C. Install M-Copilot unchanged and add a separate voice/alert layer.**
Rejected: M-Copilot cannot draw Cyrillic, has no IPC, and the second app would duplicate
subscriptions and processes.

A keeps one idea from B/C: installing M-Copilot unchanged for an afternoon is a zero-code probe
of the real car (which signals arrive, Claude latency over the uplink). That is an optional car
check, not a dependency.

## 4. Constraints established by research

Sources: `cauliflowermossgrape/idrive7-apps` (MIT, "kit A"), `robertnisipeanu/mgu-store`
(GPL-3.0), `hexlay/idrive7-custom-apps` (GPL-3.0, M-Copilot), `JustAnotherPU/mgu-apps` (MIT),
their issue trackers, and official Anthropic / vendor documentation, read on 2026-11-13.
"Verified" = the implementing code or official page was read. "Car check" = can only be settled
on the owner's unit; these are collected in §12.

The car and its owner's setup (from the owner, 2026-11-13)

- BMW X3 xDrive30i, model year 2021, North-American specification: 2.0-litre four-cylinder
  turbo petrol engine (B46/B48 family), 8-speed automatic, all-wheel drive. Derived from the
  vehicle identification number the owner supplied; **the number itself is never written to the
  repository, documentation, logs or prompts.** To be confirmed by the owner.
  Consequences: the engine unit belongs to the family the kit's diagnostic identifier tables
  were made for; the car may report in US units, so every value is read together with the car's
  unit settings; a North-American car abroad has no BMW online services, so the Store uplink is
  the only internet path.
- The MGU Store was installed by a service station. The owner does **not** hold root's SSH key
  and manages the car only through the Store (add a repository, install an app). Therefore the
  project ships an unprivileged Store app and nothing else — no root tool, no SSH-based step —
  and any recovery or re-installation after a BMW software update goes through that service
  station.
- Phone: Android, connected through Android Auto.

Platform

- Apps on the MGU are Node.js **8.16.2** processes started by BMW's app manager (MainApp), one
  process and one Linux uid per app, CommonJS only, no npm install on the unit. Verified.
  The "Node.js 22 runtime" on the owner's unit is `jap-node22`, usable only by root daemons
  ("tools"), not by apps. Verified.
- Distribution: the MGU Store builds an app **on the head unit** from a GitHub repository in
  "repo tree" layout (`mgu-repo.json` + kit + `apps/<id>/app.json` + plain JS). BMW's SDK is
  never in a repository. Private repositories are supported. Nothing is signed. Verified.
- An app with start type `autostart` starts with the platform, is restarted if it stops and is
  not stopped for being hidden. Precedents on the owner's exact firmware: iDrive Monitor
  (`jap_sysmon`), Ambient config. Verified in code; behaviour on this car = car check.
- An autostart app can raise BMW's own small pop-up (`LT_State_PopupSmall`) while its screen is
  closed — iDrive Monitor does exactly this, rate-limited and never while reversing. Verified in
  code; that it shows over navigation/CarPlay on this car = car check.
- Default per-app limits written by the kit: memory 192 MiB, `cpuLimit` 60, disk 20 MiB. The
  Store itself runs at 128 MiB / `cpuLimit` 30. One kit process costs roughly 40 MB. An app that
  exits, is killed for memory, or blocks its event loop for about a minute counts as crashed;
  stock behaviour escalates to wiping its data and uninstalling it (the Store's `app-privacy`
  patch softens this to restart-only). Verified in code/docs; real figures = car check.
- Internet exists only through the Store's `mgu-uplink` (phone hotspot, USB tethering, LTE
  stick), per app (`"mguInternet": true`), IPv4, DNS only via the uplink lease, off by default,
  intermittent, and the Wi-Fi uplink shares its radio with wireless CarPlay. An unprivileged app
  cannot open a port reachable from the phone. The unit's clock can be days off. Verified.

Vehicle data

- Passive SOME/IP subscriptions (no ECU traffic): engine speed, vehicle speed, oil and coolant
  temperature, gear, driving mode, fuel level, range, odometer, tyre pressures/targets/
  temperatures, 12 V charge %, service (CBS) list, Check Control messages, vehicle condition
  (parked / ignition / driving). Scalings and invalid-value sentinels are documented in kit A.
- Only by active read-only diagnostics (UDS `0x22` / OBD `01` to the engine unit): intake air
  temperature, real boost, engine load, 12 V voltage. Fault codes need UDS `0x19 02` sent to all
  units (seconds, up to 25 s). Every diagnostic request keeps the car awake.
- **No BMW-documented thresholds exist** in any source. Existing apps use arbitrary, mutually
  inconsistent numbers. The only BMW-authoritative warning source is Check Control.
- Kit A ships a read-only diagnostic wrapper (`readonly-diag.js`) that allows only `0x22`,
  OBD `01`/`09`; it refuses `0x19`. The community code base also contains write paths (fault
  clear, CBS reset, actuator writes) that must never be copied.

Voice and audio

- No project captures the cabin microphone; no interface to BMW's speech engine is known.
- Head-unit sound has only been achieved through state-changing calls into BMW's audio manager
  that displace the driver's audio source. Excluded (§2).
- Anthropic offers no speech-to-text or text-to-speech API. Verified against the API docs.
- Phone-side voice is proven prior art (an early M-Copilot version did it). iOS limits: Web
  Speech recognition does not work in Home-Screen web apps; web apps lose microphone and audio
  when backgrounded; CarPlay/Android Auto cannot show web apps.

Claude API

- The owner's plan (Max 20x, now named Ultra) includes **$200/month of Claude API credits**,
  claimed by linking a Claude Console organisation in claude.ai → Settings → Billing. Credits do
  not roll over; when exhausted, requests stop (never charged to the plan). Verified against
  `platform.claude.com/docs/en/about-claude/api-credits-for-subscribers` and the Ultra help
  article. Driving the app from the subscription's OAuth login is not permitted.
- The official TypeScript SDK needs Node ≥ 20, so it runs in the backend, not in the car.
- The shipped Cyrillic font atlas is Russian-only: `і ї є ґ` and the apostrophe are missing.

Ecosystem risk

- The whole custom-app ecosystem is about three weeks old, with one main maintainer for the
  Store and several releases a day. A BMW software (I-step) update removes the Store's root-side
  setup; re-installing needs root SSH and the root key. Whether the owner holds that key is
  unknown (§13).

## 5. Architecture

```
            phone (companion PWA)                       owner-hosted backend (Node 22, TypeScript)
   ┌──────────────────────────────────┐        ┌──────────────────────────────────────────────────┐
   │ push-to-talk, dialog, sensors,   │ HTTPS  │ API (REST + SSE)                                 │
   │ alerts, settings, status         │◄──────►│ Claude service (official SDK, streaming, budgets)│
   │ audio in/out ─► car speakers via │        │ speech adapters (STT / TTS)        [phase 3]     │
   │ Bluetooth / CarPlay / Android A. │        │ history store (SQLite)                           │
   └──────────────────────────────────┘        │ event engine (shared rules)                      │
                                               │ vehicle data: Mock provider | Car link provider  │
                                               └───────────────▲──────────────────────────────────┘
                                                               │ outbound HTTPS only, device token
   head unit (MGU, Node 8.16.2)                                │
   ┌───────────────────────────────────────────────────────────┴───┐
   │ car app (autostart, one process)                              │
   │  passive SOME/IP reader ─► local rule engine ─► BMW pop-up    │
   │  power gate (vehicle condition)   read-only diagnostic gate   │
   │  compact snapshot uplink (≤ 1/min while driving, when online) │
   │  minimal screen, drawn only while visible                     │
   └───────────────────────────────────────────────────────────────┘
```

Division of labour

| Concern | Car app | Backend | Phone |
|---|---|---|---|
| Read signals | ✔ | | |
| Detect alert conditions | ✔ (works offline) | re-uses same rules for mock/analysis | |
| Show alert in the car | ✔ BMW pop-up + screen | | optional spoken version |
| Claude calls, API key | | ✔ | |
| Speech recognition / synthesis | | ✔ (provider adapters) | mic + speaker |
| History, trends | RAM ring buffer only | ✔ SQLite | |
| Settings | few, on the iDrive screen | ✔ source of truth | ✔ UI |

Key decisions

- **No API key and no long-term history on the head unit.** The car holds only a device token.
- **The car only makes outbound HTTPS requests.** No listener, no firewall change, no root tool.
- **Alert detection is local and needs no internet.** Cloud explanation is an optional extra.
- **One process in the car.** No daemon, no Node 22, no Python.
- **Rules and signal decoding are shared code** used by backend and car app alike; therefore
  that code is dependency-free TypeScript compiled to ES2017 CommonJS and tested on Node 8.

## 6. Components

### 6.1 Shared packages (TypeScript, strict)

- `packages/shared` — domain types, unit helpers, API contracts (Zod schemas live here only for
  backend/companion use; nothing Node-8-bound imports Zod).
- `packages/vehicle-core` — **zero runtime dependencies, ES2017, runs on Node 8.**
  - `VehicleSnapshot`: every value is `{ value, unit, source, ageMs } | unavailable(reason)`;
    nothing is ever defaulted or estimated.
  - `VehicleDataProvider` interface: `start()`, `stop()`, `snapshot()`, `onChange(cb)`,
    `capabilities()` (which signals this vehicle actually delivers).
  - Signal catalogue: for each data point its interface/field/member, scaling, invalid
    sentinels, transport (passive | active-diag) and provenance. Every entry cites where it was
    verified; entries not verified are marked `unverified` and cannot feed a rule.
  - `MockVehicleDataProvider`: scripted scenarios (cold start and warm-up, steady cruise,
    spirited driving, overheating with a Check Control message, low tyre pressure, weak 12 V
    battery, stored fault codes, signals missing, parked). Deterministic, time-injectable.
- `packages/event-engine` — **zero runtime dependencies, ES2017, runs on Node 8.**
  Rule = `{ id, severity: info|warning|critical, provenance, condition, hysteresis, dwell,
  cooldown, dedupKey, suppressWhen, message }`. Engine features: hysteresis and dwell time,
  per-rule cooldown, de-duplication, severity ordering, global rate limit, suppression while
  reversing, bounded event history, pure functions over snapshots (no timers of its own).
- `packages/ai-core` — prompt construction and the Claude client wrapper (backend only).

### 6.2 Backend (`apps/backend`, Node 22)

- HTTP API: dialog (`ask`, history), live state (snapshot, alerts) over SSE, settings, health,
  car ingest (`/car/*`, device-token auth), pairing.
- Claude service — built with the official `@anthropic-ai/sdk`, following the `claude-api`
  skill's current rules. Model is configuration (`CLAUDE_MODEL`, default `claude-opus-5-5`;
  optional `CLAUDE_MODEL_VOICE` override for the low-latency spoken route — which model to put
  there is the owner's choice after measuring latency, see §13). Streaming; adaptive thinking;
  explicit `output_config.effort`; `stop_reason` checked before content (`refusal`,
  `max_tokens`); server-side refusal fallback only on models that support it; no sampling
  parameters, no prefill, no forced tool choice; typed error chain; SDK retries with bounded
  attempts; prompt laid out for caching (frozen instructions first, cache breakpoint, then the
  volatile vehicle snapshot and dialog).
- Cost guard: per-request `max_tokens`, daily and monthly token/USD budget computed from
  `response.usage`, request rate limit, hard stop with a clear Ukrainian message when a budget or
  the credit balance is exhausted (never retried). A Console workspace spend limit is the outer
  cap (owner action).
- Prompt rules (ideas adopted from M-Copilot, text written fresh): answer in Ukrainian; state data
  limits; short answers while moving (snapshot says moving/standing), fuller when parked; advice
  is cautious and never a command to the car.
- Numbers in answers (designer's call, see §15):
  - *About this car* (readings, targets, limits, states) — only what the snapshot contains, with
    its age. A value the car did not report is named as unavailable and never estimated.
  - *General automotive knowledge* (e.g. typical operating ranges for a turbo petrol engine) —
    allowed, because otherwise "is that normal?" cannot be answered, but always labelled as
    general guidance and never presented as BMW's limit for this car or as a go-ahead.
  - Limits configured by the owner are quoted as the owner's own.
  - Enforcement is by prompt, not by a filter on the output (a pre-display check would break
    streaming and sentence-by-sentence speech). Phase 1 tests cover the prompt builder
    (instructions present, unavailable values listed, provenance labels attached). A small
    opt-in live evaluation script (needs an API key, not part of CI) asks a fixed set of
    Ukrainian questions against mock scenarios and reports answers that contain a car value
    absent from the snapshot.
- Privacy: only VIN characters 1–11 (type part) may ever be sent; no GPS; no names/contacts.
- Storage: SQLite — dialog turns, alert events, telemetry samples (1/min) with daily roll-ups
  and retention limits.
- Offline/timeout behaviour: bounded timeouts, clear error states surfaced to the UI.
- Logging: structured, secrets redacted by construction (key never passed to the logger).
- Config: environment variables only; `.env.example` committed, `.env` ignored.
- A `mock` Claude mode so the whole stack runs and is demoed without an API key; tests never
  call the real API.

### 6.3 Companion (`apps/companion`, Angular PWA, mobile-first, dark)

Phase 1 form = the local web panel: live sensor tiles, alert list, dialog with history, mock
scenario picker, status (Claude API, backend, vehicle link), settings. Phase 3 adds the large
push-to-talk control and audio playback. While the vehicle is moving the companion shows minimal
text and no multi-step interactions.

### 6.4 Car app (`car/`, phase 2+) — Node 8.16.2, one autostart process

Authored in TypeScript, compiled to flat ES2017 CommonJS with no runtime dependencies; uses the
MIT app kit (kit A, with the pop-up and start-type additions that `JustAnotherPU/mgu-apps`' MIT
copy of the kit already has). Requires only the GPU renderer; does **not** use the controller
gate (`mgu-inputgate`, an LD_PRELOAD into BMW's HMI) or controller grab.

- `BmwMguVehicleDataProvider`: passive subscriptions only — one watch per interface,
  assign-only handlers, getter polling (≥ 10 s) only for fields that never notify.
- Power gate: all work is conditional on vehicle condition. Parked/locked → no timers, no
  network, no diagnostics. Never calls wake-up or shutdown-client interfaces.
- Rule tick: 1 Hz while ignition is on; rules from `event-engine`.
- Alert presenter: BMW small pop-up, auto-closing, Ukrainian text; cooldown ≥ 10 min per rule,
  global rate limit, none while reversing, lowest pop-up priority so BMW's own always win.
- Read-only diagnostic gate: an allow-list wrapper (0x22, OBD 01/09, and exactly `0x19 02` /
  `0x19 17`) around a privately held transport; everything else throws; unit tests assert that
  10/11/14/27/28/2E/2F/31/34–37/3E/85 are refused. Reads happen only on explicit user request
  (or, as an opt-in setting, once per drive start), only when awake and steady (not while the
  engine is starting or stopping), one request at a time, results cached ≥ 5 min. Claude never
  chooses services or identifiers. **Diagnostics are disabled by default** until the owner has
  approved the on-car diagnostic checks (§12).
- Uplink client: raw HTTPS on Node 8 (uplink-lease DNS, certificate verification that tolerates
  a wrong clock without disabling verification), one keep-alive connection, compact JSON
  snapshot at most once a minute while driving and immediately on an alert, RAM ring buffer when
  offline, no retries on non-retryable errors. While the screen is visible it may hold one
  long-poll/SSE connection to show dialog updates; hidden → no open connection.
- Screen (drawn only while visible, on change, ≤ 4 fps, 1 fps keep-alive): status line
  (vehicle link, internet, backend/Claude), sensor tiles for the signals this car delivers,
  alert list, last dialog turns, topic chips to ask without typing; no keyboard and no scrolling
  while moving. Ukrainian text needs a re-baked font atlas containing the full Ukrainian
  alphabet.
- Pairing: the car generates a random device id and secret and shows them as a QR code; the
  companion scans it and registers the device with the backend. No API key ever travels to the
  car.
- Backend address: **never committed to a public repository** (the Store builds from the
  repository, so anything there is published). Default mechanism: during pairing the companion
  sends the address to the car once through an end-to-end-encrypted rendezvous whose key is in
  the QR code (the relay sees only ciphertext — the pattern M-Copilot proved, re-implemented).
  If the owner keeps the Store-source repository private, a configuration file there is the
  simpler alternative. Chosen at the start of phase 2; nothing about it is built in phase 1.
- Robustness: never throws out of a timer/handler, never exits on its own, bounded buffers,
  atomic small writes, at most a handful of log lines per drive.

## 7. Alert policy (no invented thresholds)

Every rule carries a `provenance`:

- `bmw-check-control` — a Check Control message became active. Authoritative. Enabled.
  The assistant relays it and, when online, adds Claude's explanation and a cautious next step.
- `bmw-fault-status` — a fault code whose status byte says active now / warning lamp requested,
  seen in a user-requested fault read. Enabled.
- `bmw-service` — a CBS service item turned due/overdue. Enabled, at most once per state change.
- `owner-configured` — numeric limits (coolant/oil temperature, 12 V, tyre-pressure deviation
  from the car's own target) that the owner sets himself. **Shipped disabled with empty
  values**; the UI labels them as the owner's own limits, not BMW limits.

There is no rule with a built-in numeric default. The car's own targets (e.g. tyre pressure
target next to actual pressure) are shown on the tiles and given to Claude as context; they
raise an alert only through an owner-configured tolerance or through BMW's own Check Control
message.

What a Check Control entry contains (from the kit and M-Copilot code): the master list gives a
message id, an active state and the requesting control unit; the cluster interface gives an id,
a short name (text formatted by the car) and a colour. So the alert text is the car's own short
name when it arrives. When only an id is available the alert says "BMW Check Control message
<id>", and Claude is told the text is unavailable and must not guess its meaning. The mock
provider has scenarios for both cases. Severity follows the car's colour (red → critical,
yellow → warning, otherwise info; unknown → warning). The language of the car's text and its
timing versus the cluster are car checks.

Presentation: `critical` and `warning` events raise one BMW small pop-up each, shown after a
short settle delay so BMW's own message appears first, auto-closing, lowest priority; `info`
events go to the alert list only. A setting turns pop-ups off (list only).

Warm-up advice ("can I load the engine yet?") is an answer to a question, not a pop-up: Claude
receives oil and coolant temperature with their age and is instructed to explain what the data
does and does not show.

## 8. Voice (phase 3 outline)

Push-to-talk in the companion → recorded clip → backend speech-to-text (Ukrainian) → Claude
(short spoken style) → text-to-speech (Ukrainian, sentence by sentence) → the phone plays it →
car speakers through the phone's Android Auto / Bluetooth audio. The transcript and answer also
appear on the iDrive screen. No always-on listening.

The owner uses Android with Android Auto and wants a free speech path if one exists. Default
therefore: **the browser's own speech in Chrome on Android** — Web Speech recognition with
`uk-UA` (Google's online recogniser, no fee) and `speechSynthesis` with the phone's Ukrainian
voice. In that mode the backend receives text and returns text; speech costs nothing and needs
no extra account. Speech sits behind an adapter interface so that cloud providers (research
favourites: OpenAI `gpt-transcribe`, Google Chirp 3 HD `uk-UA`, about $1/month at 20 exchanges
a day) can be added later if recognition or voice quality in the car is not good enough.

Known limits to test in the car: Android Auto cannot show a web app, so the companion runs on
the phone's own screen (phone mounted, one large button); recognition works only while the page
is in the foreground and after a tap; which microphone Android uses while Android Auto is active,
and how the car's audio switches between media and call mode during capture, must be observed.

## 9. Resource budgets for the head unit

Targets to be confirmed or tightened by measurement (§12); the app reports its own figures.

| Resource | Budget |
|---|---|
| Processes | 1 (Node 8), no daemon |
| Memory | declared cap 128 MiB (`memoryKB`), target steady RSS ≤ 60 MB, zero growth over a drive |
| CPU | declared `cpuLimit` 30; hidden: one 1 Hz tick + event handlers; parked: zero timers |
| Rendering | only while visible, on change, ≤ 4 fps; never the software PNG path above 1 fps; no home-screen widget |
| Storage writes | no telemetry history on flash; ≤ 1 small atomic state write per drive; log ≤ 256 KB with one rotation |
| Network | hidden + driving: ≤ 1 small POST/min; parked: none; no polling, no probes |
| Diagnostics | none in the background by default |
| 12 V | no measurable change in head-unit shutdown time or overnight voltage with the app installed |

Self-measurement: the app logs `process.memoryUsage()` and `process.cpuUsage()` deltas at a low
rate; the owner's iDrive Monitor gives the system-wide view.

## 10. Repository layout

```
apps/backend/          Node 22 API, Claude service, stores
apps/companion/        Angular PWA (phase 1: local web panel)
packages/shared/       types, contracts
packages/vehicle-core/ provider interface, signal catalogue, mock provider   (Node 8-safe)
packages/event-engine/ rules engine                                          (Node 8-safe)
packages/ai-core/      prompts, Claude wrapper
car/                   phase 2: car app sources, vendored MIT kit, Store manifest
docs/                  ARCHITECTURE.md, ROADMAP.md, COMPATIBILITY.md, CAR_CHECKLIST.md
```

npm workspaces, strict TypeScript, Vitest, ESLint. Licence: MIT for our code (approach A); the
vendored kit keeps its MIT notice. No GPL code is copied; GPL projects are used as documentation
of behaviour only.

## 11. Phases and exit criteria

- **Phase 0 — research and architecture.** Research done (this document). Exit: owner approves;
  `docs/ARCHITECTURE.md`, `ROADMAP.md`, `COMPATIBILITY.md` (facts versus hypotheses versus
  unverified) and `CAR_CHECKLIST.md` written from the research. These four documents are the
  first task of the implementation plan, not a precondition for it.

  Research record: ten reports with per-signal detail (interface, field, member, scaling,
  sentinels) and file-and-line citations are kept locally in `.research/reports/` (gitignored),
  together with trimmed copies of the reference repositories at the commits that were read:
  `idrive7-apps` `4a8deb7`, `mgu-store` `f4daf7a`, `idrive7-custom-apps` `06ea119`, and
  `JustAnotherPU/mgu-apps` as fetched on 2026-11-13. The signal catalogue is built from that
  record, not re-derived from the moving upstream branches. Research claims were cross-checked
  between independent reports and two were re-verified directly (background pop-up, API
  credits); a separate adversarial verification pass did not complete, so anything the
  catalogue marks `verified` must cite a file and line from the pinned copies.
- **Phase 1 — working MVP without a car.** Backend with Claude, dialog history, mock vehicle,
  rule-based alerts, web panel, env-based configuration, unit and integration tests, Docker
  Compose, README. Exit: `mock telemetry → event engine → Claude → response → UI` demonstrated
  locally, with and without an API key (mock mode); all checks green; shared packages pass on
  Node 8.16.2.
- **Phase 2 — car integration (read-only).** Car app with real passive telemetry, Ukrainian
  screen, pairing, uplink, Store package. Exit: installed by the owner through the Store, shows
  live values that match the cluster, answers a question on the iDrive screen, resource figures
  within budget.
- **Phase 3 — voice.** Exit: push-to-talk Ukrainian question answered aloud through the car's
  speakers via the phone.
- **Phase 4 — background assistant.** Autostart, local rules, pop-ups, alert history, power
  gating. Exit: a deliberately triggered harmless Check Control produces one correct pop-up with
  the screen closed; head-unit shutdown time and overnight 12 V unchanged.
- **Phase 5 — advanced.** Maintenance advice, trip and long-term trends, optional read-only
  diagnostics extras, optional wake word in a native wrapper.

Nothing is installed on the car by the project itself; every on-car step is performed by the
owner after reading what it does.

## 12. Car checks (first pass, ordered)

Before any of our code is installed

1. Store → Installed: note id/version/source of every component (expect `jap-node22`,
   `jap_sysmon`, a Tailscale tool, renderer, `mgu-uplink`, `app-privacy`, `mgu-deploy` ≥ 0.8.16).
2. Ask the service station that installed the Store: do they keep root's SSH key for this car,
   and what is their procedure before and after a BMW software update?
3. iDrive Monitor → "Test pop-up": does the pop-up appear; does it also appear while navigation
   or CarPlay is in front? Note CPU %, free memory and app memory versus cap at idle.
4. Store → Settings → Wi-Fi: uplink online over the phone's hotspot; any CarPlay audio skips?
5. Head-unit clock versus real time.
6. Centre display size (10.25" or 12.3"), audio system option, whether Android Auto is wired or
   wireless, and which units the car displays (°C/°F, bar/psi, km/miles).

With a minimal read-only test app (phase 2)

7. Node version, `typeof global.gc`, RSS and CPU over a 30-minute drive and 30 minutes idle.
8. Which catalogue signals this G01 delivers, their notification rates, and values compared
   with the cluster (rpm, speed, oil, coolant, fuel, range, odometer, tyre pressures and unit).
9. Autostart: starts after ignition without opening the tile; survives 60+ minutes; what
   happens on tile tap; when it receives shutdown after locking.
10. Check Control: trigger a harmless message and record structure, text language and latency.
11. Ukrainian glyphs on the drawn screen and in a BMW pop-up.
12. TLS handshake and one request to the backend over the uplink; latency.
13. Overnight: head-unit shutdown time and 12 V with and without the app.

Only after separate explicit approval

14. One read-only fault-memory read (`19 02 0C`), parked, ignition on, engine off: duration,
    number of units, and that no new warning appears afterwards.

## 13. Open decisions (owner)

Answered by the owner on 2026-11-13: approach A with reuse allowed (§3); Android with Android
Auto; Store installed by a service station, no root key; third-party speech acceptable but a
free path preferred (§8); the car is an X3 xDrive30i (§4).

Still open — none blocks phase 1:

1. Model for the spoken route: stay on the default (`claude-opus-5-5`) or use a faster model
   (`claude-haiku-5-5`) after measuring latency.
2. Where the backend will be hosted for real use.
3. Repository stays public or becomes private (also decides how the car learns the backend
   address, §6.4).
4. Confirmation that the model/engine reading in §4 is right.

## 15. Calls made by the designer (owner: please check these)

- MIT licence for our code; MIT sources copied with notice, GPL sources re-implemented.
- Speech defaults to the free browser path on Android; cloud speech is an optional adapter.
- Only an unprivileged Store app is shipped (no root tool), since the owner has no root key.
- Default model `claude-opus-5-5`, configurable; a separate optional setting for the spoken
  route.
- Claude may use general automotive knowledge when it is labelled as such; car-specific numbers
  only from the car. Enforced by prompt and an opt-in evaluation script, not by an output filter.
- No alert rule ships with a numeric default; numeric limits are the owner's to set.
- Our pop-up follows BMW's own message after a short delay, lowest priority, can be switched off.
- Diagnostics (fault-memory read) disabled by default until separately approved on the car.
- No head-unit audio, no steering-wheel voice button, no HUD/cluster output, no controller gate.
- The backend address is never committed to a public repository.
- History lives in the backend; the car keeps only a RAM buffer.

## 14. Left to the builder

Framework choices inside the stated stack (HTTP framework, SQLite binding, logger, Angular
version and state approach), file-level structure, API route shapes, the exact Ukrainian
wording, simulator curves, test layout, CI, and — in phase 2 — the Store manifest mechanics
(committed build output versus a build branch) and which MIT kit copy to vendor after diffing
them.
