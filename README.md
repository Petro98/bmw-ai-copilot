# BMW AI Copilot

A personal, Ukrainian-speaking assistant for one car: a BMW X3 xDrive30i, model year 2021 (to be confirmed by the
owner), with the MGU head unit (iDrive 7). It answers questions about the car using the car's own data and Claude,
watches the readings while driving, and warns about problems. It is strictly read-only towards the vehicle.

The project has three parts:

- **Backend** (`apps/backend`, Node 22): REST and server-sent-events API, the Claude service, the rule engine
  and an SQLite history of dialog, alerts, telemetry and spend.
- **Phone panel** (`apps/companion`, Angular): assistant, car readings and alerts, settings.
- **Car app** (`car/`, Node 8.16.2 on the head unit): a thin client with the Ukrainian iDrive screens. Phase 2;
  see [docs/CAR_INSTALL.md](docs/CAR_INSTALL.md).

Shared code lives in `packages/` (`vehicle-core` and `event-engine` also run on the head unit's Node 8.16.2;
`ai-core` builds prompts and wraps the Anthropic SDK; `shared` holds the API contracts).

Phase 1 runs entirely without a car: a mock vehicle plays scripted scenarios through the same path a real car
will use: mock telemetry → rule engine → Claude → answer → panel.

## Safety rules

1. **Read-only.** Nothing writes to the vehicle, controls a vehicle function, codes, clears faults or sends a
   diagnostic request.
2. **No invented values.** Every number, limit and signal comes from the car or from the owner, with its source
   shown; a missing value is shown as «Недоступно», never guessed. No alert has a built-in threshold.
3. **BMW warnings come first.** Nothing hides, delays or replaces a warning the car shows.
4. **No secrets or identity in the tree or the logs.** The API key comes only from the environment; no vehicle
   identification number, e-mail address or other personal data is committed or logged.
5. **Nothing reaches the car on its own.** Every on-car step is done by the owner, each time, after reading what
   it does; the head-unit app must keep its CPU, memory, writes, network and 12 V use minimal.

## Prerequisites

- Node.js 22.13 or later (`.nvmrc` says 22) with npm 10.
- Docker with Compose v2.24 or later, only for the container run.
- python3, only for the car app's offline preview (`npm run check:car`).
- A Node 8.16.2 runtime for the head-unit checks: the Docker image `node:8.16.2` (used automatically when the Docker
  daemon is running), `NODE8_BIN` pointing at a v8.16.2 binary, or `npx` on x86_64. Node 8 has no arm64 build; on an
  Apple Silicon Mac without Docker see `NODE8_STATIC_FALLBACK=1` below. CI always runs the real Node 8.16.2.

Install the dependencies (the panel is a separate npm project with its own lockfile):

```sh
npm ci
(cd apps/companion && npm ci)
```

## Configuration

```sh
cp .env.example .env
```

`.env.example` lists every variable with its default and a one-line explanation; every one is optional. `.env` is
git-ignored: never commit it. Docker Compose reads `.env` itself. The backend started with npm reads only its process
environment and does not load `.env` by itself; export the file first when you want it:

```sh
set -a; . ./.env; set +a
```

## Running in development

Backend (http://127.0.0.1:3000, restarts on change):

```sh
npm run dev -w @copilot/backend
curl -s localhost:3000/api/status
```

npm runs the script inside `apps/backend`, so the default `DATABASE_PATH=./data/copilot.sqlite` is
`apps/backend/data/copilot.sqlite` (git-ignored). Set `DATABASE_PATH` to put it elsewhere.

Panel (http://localhost:4200; the dev server proxies `/api` to the backend on port 3000):

```sh
cd apps/companion
npm start
```

Open «Налаштування» → «Демо-сценарій» and pick «Перегрів і повідомлення Check Control»: about a minute later the
car's Check Control message appears on «Авто», and a topic chip on «Голос» streams an answer.

Production build of the backend (one bundled file, run with production dependencies only):

```sh
npm run build -w @copilot/backend     # apps/backend/dist/main.js
npm start -w @copilot/backend
```

## Running with Docker Compose

```sh
docker compose up --build
```

- Panel: http://localhost:8080 (nginx serves the build and proxies `/api` to the backend).
- Backend: http://localhost:3000/api/health.

Both ports are bound to 127.0.0.1 only. The backend runs as a non-root user; its database lives in the named volume
`bmw-ai-copilot_copilot-data`, which `docker compose down` keeps and `docker compose down -v` deletes. `.env` is
optional; inside the container `HOST`, `PORT` and `DATABASE_PATH` always come from `docker-compose.yml`.

## Mock mode and live mode

- **Mock mode** (the default without a key): no request leaves the machine. A stand-in answers in Ukrainian from the
  prompt's vehicle data, word by word, beginning with «Демо-режим без Claude.». The panel's «CLAUDE» mark shows that
  Claude is not connected.
- **Live mode**: set `ANTHROPIC_API_KEY` in `.env` (with the default `CLAUDE_MODE=auto` a key switches live mode on;
  `CLAUDE_MODE=live` without a key refuses to start; `CLAUDE_MODE=mock` never calls Claude). The model is
  `CLAUDE_MODEL` (default `claude-opus-5-5`). Spend is capped by `BUDGET_DAILY_USD`, `BUDGET_MONTHLY_USD` and
  `RATE_LIMIT_PER_MINUTE`; a question over budget is refused with a Ukrainian message.

The API key is created in the **Claude Console** (platform.claude.com) under the organisation linked to your
subscription: sign in there, open the organisation's API keys page, create a key, and put it only in `.env`. Never
use your subscription login or password in this project; the backend never needs them. The key is never logged and
never appears in an API response.

## Owner access, device pairing and the car source

- **Owner access.** Set `OWNER_TOKEN` (at least 24 characters, random) and `SESSION_SECRET` (at least 32
  characters) in `.env`. The panel then opens «Вхід» first; the token is typed once and the browser keeps an
  `HttpOnly`, `Secure`, `SameSite=Strict` session cookie for 30 days (`DELETE /api/session` ends it, a new
  `SESSION_SECRET` ends every session). Without `OWNER_TOKEN` the API is open, so the backend refuses to start unless
  `HOST` is a loopback address; inside the Docker Compose container `HOST` is `0.0.0.0`, so Compose needs both
  variables in `.env`. The cookie is `Secure`: serve the panel over HTTPS (browsers also accept it on
  `http://localhost`).
- **Lock-out.** Five wrong tokens from one address within a minute lock that address out for a minute. The address
  is the TCP peer of the backend: behind a reverse proxy (nginx in Docker Compose included) every visitor shares the
  proxy's address, so one person mistyping locks everyone out for that minute. `X-Forwarded-For` is not trusted.
- **Pairing the car.** The head-unit app makes its own device id and secret on its first run and shows a QR code
  of `<panel address>/pair#d=<device id>&s=<secret>`. Scan it with the phone: the «Підʼєднати авто» page reads the
  fragment, removes it from the address bar at once, asks for the owner's sign-in if needed, and registers the
  device with a label. The backend keeps only a SHA-256 of the secret. «Налаштування» → «ПІДʼЄДНАНІ ПРИСТРОЇ»
  lists the paired devices and «Відʼєднати» revokes one at once.
- **The car as vehicle source.** `VEHICLE_SOURCE=car` replaces the mock vehicle with what the paired car posts to
  `/car/v1/*` (each request carries `Authorization: Bearer <device id>.<secret>`). The car evaluates the alert rules
  itself, so the backend runs no rule engine then; the demo scenarios (`/api/mock/*`) answer 404, and «АВТО» in the
  panel shows connected while the car has reported within the last three minutes. A car that went quiet leaves its
  last readings visible with their real times, so they age. The `/car/v1` paths must reach the backend through
  whatever serves the panel's address.

## Tests and gates

From the repository root:

```sh
npm run typecheck                    # every workspace
npm run lint
npm test                             # every workspace (Vitest); tests never call the real Claude API
npm test -w @copilot/backend -- vertical-slice   # the phase-1 end-to-end path on its own
npm run node8                        # shared packages: smoke test on Node 8.16.2
NODE8_STATIC_FALLBACK=1 npm run node8              # machines without Node 8: static ES2017 parse only, not a runtime test
npm run build:car                    # head-unit bundle: car/apps/p98_copilot/main.js (committed)
npm run check:car                    # bundle, Node 8.16.2 syntax check, offline screen preview (car/preview/*.png)
NODE8_STATIC_FALLBACK=1 npm run check:car          # the same without a Node 8 runtime
npm test -w car                      # head-unit app tests
node car/kit/tools/test_runtime.js   # vendored kit runtime tests
```

Panel:

```sh
cd apps/companion
npm test                             # headless (Vitest with jsdom)
npm run build
```

Without a Node 8.16.2 runtime, `scripts/run-node8.sh` stops with exit status 3 unless `NODE8_STATIC_FALLBACK=1` is
set. CI (`.github/workflows/ci.yml`) runs all of the above on Node 22 and the Node 8 steps on the real Node 8.16.2,
and checks that the committed car bundle matches its sources.

Optional answer check against the real API (costs money, 18 requests; never run in CI):

```sh
ANTHROPIC_API_KEY=... npx tsx --tsconfig tsconfig.base.json scripts/eval-claude.ts
```

It asks the panel's six topic questions against three mock scenarios and prints every answer, flagging car-style
numbers that do not occur in the data Claude was given.

## Where things are

- Design: [docs/superpowers/specs/2026-11-13-bmw-ai-copilot-design.md](docs/superpowers/specs/2026-11-13-bmw-ai-copilot-design.md)
- Implementation plans: [docs/superpowers/plans/](docs/superpowers/plans/)
- Architecture, roadmap and compatibility record: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [docs/ROADMAP.md](docs/ROADMAP.md), [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)
- Design language (colours, type, spacing, copy) and phone and head-unit mockups: [docs/design/README.md](docs/design/README.md),
  [docs/design/tokens.json](docs/design/tokens.json), [docs/design/mockups/](docs/design/mockups/)
- Car documents: [docs/CAR_INSTALL.md](docs/CAR_INSTALL.md) (installing the head-unit app),
  [docs/CAR_CHECKLIST.md](docs/CAR_CHECKLIST.md) (on-car checks), [car/kit/VENDORED.md](car/kit/VENDORED.md)
  (the vendored MIT app kit and its local edits)

## Licence

MIT, see [LICENSE](LICENSE). The vendored app kit in `car/kit/` keeps its own MIT notices.
