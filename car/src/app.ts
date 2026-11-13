/**
 * The head-unit app, wired (Plan 2 Task 9): state file → vehicle provider → power gate → rule runner (with the
 * shared event engine) → BMW pop-up presenter → uplink → screen. car/src/main.ts calls startApp once from the
 * kit's start(ctx); everything here is injected, so it runs unchanged against a fake kit in car/src/app.test.ts.
 *
 * Power (spec §9, car/src/power/power-gate.ts):
 *   - awake or driving: exactly one 1000 ms interval. Each tick refreshes the provider and runs the rules
 *     (RuleRunner.tick), updates the power gate, keeps a snapshot for the uplink once a minute, lets the uplink
 *     send what is due, and self-measures (a line at most every ten minutes).
 *   - asleep: no timer at all. The tick stops, the pop-up presenter closes everything, the dialog poll ends, the
 *     uplink closes (it refuses everything until reopened), the provider is suspended (only its passive
 *     vehicle-condition watch stays) and the state file is written once. A condition change is the only way
 *     back: the suspended provider notifies its listeners for it, and the listener updates the gate.
 *   - waking: the provider resumes, the uplink reopens and lifts a refusal block (retry), the tick starts again,
 *     the car's config (owner limits, the phone's pop-up switch) is fetched once when online.
 *
 * Pairing: the car makes up its device id and secret on its first run (`random`). The pairing panel (a QR code
 * of the phone's /pair address) shows until the backend has answered a request from this device as authorised;
 * that fact is kept in the state file (`paired`), and a 401/403 later clears it. Before any request has been
 * answered in this waking period the network marks never read as working.
 *
 * Alerts to the phone: a raised `critical` or `warning` alert is sent at once; its clearing and a re-opening (both
 * under the id of the raise) are queued and go with the next raise or the next minute's batch (UplinkClient
 * queueAlerts), so the car link stays within its once-a-minute budget. The backend has no rules of its own when
 * the car is the vehicle source: without these, an alert the car raised would never clear on the phone. `info`
 * alerts stay on the car, and so do their clearings, except a clearing rebuilt after a restart (severity 'info',
 * empty title), whose original severity is unknown.
 *
 * The owner's test switch «Тестове сповіщення» (settings key `testPopup`): turning it on (off to on) shows one
 * pop-up «Тестове сповіщення Copilot» through the presenter, with the same gates as an alert, and nothing is
 * listed, kept or sent. The app cannot turn the switch back off (our code has no settings writer: kit.d.ts), so
 * it fires once per off-to-on change. While asleep it does nothing.
 *
 * Writes (spec §9): the state file is written when the car falls asleep (once per drive), when the device is
 * created, when pairing changes, and when the owner's settings or the fetched config change. persist() writes it
 * only if something changed since the last write; main.ts calls it when the process exits, so a restart in the
 * middle of a drive keeps the alert memory. The device secret is never logged.
 *
 * Every timer callback, listener and promise chain goes through safe() (car/src/safe.ts).
 */
import { EventEngine, defaultEngineOptions, type AlertEvent } from '@copilot/event-engine';
import { emptySnapshot, type Clock, type SnapshotKey, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { CarConfigResponse, DialogTurn } from '@copilot/shared';
import { AlertPresenter, popupGates } from './alerts/alert-presenter';
import { RuleRunner, isReopened } from './alerts/rule-runner';
import type { FsApi, FullTimerApi, KitContext } from './platform';
import { PowerGate, type PowerState } from './power/power-gate';
import { BmwMguVehicleDataProvider, type SignalsApi } from './provider/bmw-provider';
import { safe, type Log } from './safe';
import { measure, type Sample } from './selfmeasure';
import { StateFile, type PersistedState } from './state/state-file';
import type { FrameFn } from './ui/draw-header';
import { SCREEN, startScreen, type Screen, type ScreenInput } from './ui/screen';
import { TEXT_TEST_POPUP } from './ui/strings.uk';
import { pairingUrl } from './ui/view-model';
import { HttpsClient, UplinkError, type RequestOptions } from './uplink/https-client';
import { readLease } from './uplink/lease';
import { UplinkClient, type LinkStatus } from './uplink/uplink-client';

export interface AppDeps {
  ctx: KitContext;
  clock: Clock;
  timers: FullTimerApi;
  fs: FsApi;
  config: {
    backendUrl: string | null;
    /** Readings whose signal the deployed app.json leaves out (car/scripts/publish-car.mjs --drop-reading). */
    droppedReadings?: string[];
    /** Interfaces the installer left out on this unit (the kit's missing-interfaces.json). */
    missingInterfaces?: string[];
  };
  /** `bytes` random bytes as hex (main.ts: crypto.randomBytes). */
  random: (bytes: number) => string;
  /** The kit's fonts.has and gauges.frame for the screen (main.ts requires them from ./kit). */
  screenKit?: { has: (cp: number) => boolean; frame: FrameFn };
  /** The uplink's HTTPS client; tests inject a fake. Default: an HttpsClient on config.backendUrl. */
  http?: HttpsClient;
}

export interface AppHandle {
  /** Clears every timer, poll, pop-up and watch (for tests; on the car the kit's shutdown path ends the process). */
  stop(): void;
  /** Writes the state file if anything in it changed since the last write (main.ts: on the process's exit). */
  persist(): void;
  /** What the app holds now (for tests and the preview). */
  inspect(): { power: PowerState; queued: { snapshots: number; alerts: number }; history: number; screen: ScreenInput };
}

/** The one interval while the gate is awake or driving. */
export const TICK_MS = 1000;
/** A snapshot is kept for the uplink at most this often (it sends them only while driving, once a minute). */
export const SNAPSHOT_EVERY_MS = 60_000;
/** After a failed dialog poll (or one answered at once with nothing), the next one waits this long. */
export const POLL_RETRY_MS = 5000;
/** While the pairing panel is shown, a refused device is tried again at most this often. */
export const PAIRING_RETRY_MS = 30_000;
/** A config fetch that failed is tried again at most this often while awake. */
export const CONFIG_RETRY_MS = 60_000;
/** The screen's alert list keeps at most this many events (it shows four). */
export const LISTED_MAX = 20;
/** Device id: 12 random bytes, 24 hex characters (the backend accepts 16-64 URL-safe characters). */
const DEVICE_ID_BYTES = 12;
/** Device secret: 32 random bytes, 64 hex characters (the backend asks for at least 32). */
const DEVICE_SECRET_BYTES = 32;
/** The car's settings switch that shows the test pop-up (app.json "settings"). */
export const TEST_POPUP_SETTING = 'testPopup';
/** The presenter's de-duplication id of the test pop-up. */
const TEST_POPUP_ID = 'copilot-test-popup';

/** The Ukrainian error lines on the assistant tab (plan 2 Task 9). */
export const TEXT_NO_SERVER = 'Немає зв\'язку з сервером';
export const TEXT_CLOCK = 'Годинник головного блока неправильний';
export const TEXT_REFUSED = 'Сервер відхилив запит';

/** The line for a failed question. */
function errorLine(error: unknown): string {
  const kind = error instanceof UplinkError ? error.kind : null;
  if (kind === 'clock') return TEXT_CLOCK;
  if (kind === 'unauthorized' || kind === 'client-error') return TEXT_REFUSED;
  return TEXT_NO_SERVER;
}

/** The snapshot's own keys: a dropped reading must name one of them. */
const SNAPSHOT_KEYS: string[] = Object.keys(emptySnapshot(0)).filter((k) => k !== 'takenAt');

function stringList(v: unknown, keep: (s: string) => boolean): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) if (typeof item === 'string' && keep(item) && out.indexOf(item) < 0) out.push(item);
  return out;
}

/** A file system with nothing on it that keeps nothing: used when the kit gives no data folder. */
const NO_DISK: FsApi = {
  existsSync: () => false,
  readFileSync: () => {
    throw new Error('no data folder');
  },
  writeFileSync: () => undefined,
  renameSync: () => undefined,
};

function isTurn(v: unknown): v is DialogTurn {
  return typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';
}

/** Whether an event goes to the phone: raised alerts the car pops up, and every later state of those. */
function uploads(event: AlertEvent): boolean {
  if (event.severity === 'critical' || event.severity === 'warning') return true;
  // a clearing rebuilt after a restart carries severity 'info' and an empty title (rule-runner.ts restoredClearing).
  // Its original severity is not kept anywhere, so it is sent even when the raise was an info alert the phone never
  // got: the backend then holds a cleared alert with an empty title under an id it did not know (open question).
  return event.active === false && event.title === '';
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function startApp(deps: AppDeps): AppHandle {
  const { ctx, clock, timers, fs } = deps;
  const log: Log = ctx.log;
  const backendUrl = typeof deps.config.backendUrl === 'string' && deps.config.backendUrl.trim() !== '' ? deps.config.backendUrl.trim() : null;
  const has = deps.screenKit ? deps.screenKit.has : () => true;
  const frame: FrameFn = deps.screenKit ? deps.screenKit.frame : () => undefined;
  let stopped = false;

  const setting = (key: string): unknown => {
    try {
      return ctx.settings.get(key);
    } catch {
      return undefined;
    }
  };

  /* ---------- 1. the state file and the device ---------- */

  // The kit gives every app its own data folder: <app>/data on the head unit, else the process's working directory
  // (car/kit/runtime/mgu.js:36 DATA_DIR, handed over as ctx.dataDir). Without one nothing is written anywhere.
  const dataDir = typeof ctx.dataDir === 'string' && ctx.dataDir.trim() !== '' ? ctx.dataDir : null;
  if (dataDir === null) log.warn('no data folder: the state is kept in memory only');
  const stateFile = new StateFile({ dir: dataDir || '', fs: dataDir ? fs : NO_DISK, log });
  const state: PersistedState = stateFile.load();
  state.paired = state.paired === true;
  const latin = setting('latinPopups');
  if (typeof latin === 'boolean') state.asciiPopups = latin;

  const engine = new EventEngine(defaultEngineOptions());
  try {
    engine.restore(state.engine);
  } catch {
    log.warn('state file: engine memory not restored, starting clean');
  }

  let lastSaved = '';
  const snapshotOfState = (): string => {
    state.engine = engine.state();
    return JSON.stringify(state);
  };
  const save = (): void => {
    try {
      lastSaved = snapshotOfState();
    } catch {
      lastSaved = '';
    }
    stateFile.save(state);
  };
  const saveIfChanged = (): void => {
    let current: string;
    try {
      current = snapshotOfState();
    } catch {
      current = '';
    }
    if (current === '' || current !== lastSaved) save();
  };

  if (!state.device) {
    try {
      const id = deps.random(DEVICE_ID_BYTES);
      const secret = deps.random(DEVICE_SECRET_BYTES);
      if (typeof id === 'string' && typeof secret === 'string' && id.length >= 16 && secret.length >= 32) {
        state.device = { id, secret };
        state.paired = false;
        log.info('first run: a new device id was created for pairing');
      }
    } catch {
      log.warn('first run: no random source, the car cannot pair');
    }
    save();
  } else {
    try {
      lastSaved = snapshotOfState();
    } catch {
      lastSaved = '';
    }
  }

  /* ---------- 2. provider, gate, rules, pop-ups, uplink, screen ---------- */

  const provider = new BmwMguVehicleDataProvider({
    signals: ctx.signals as unknown as SignalsApi,
    clock,
    log,
    missingInterfaces: stringList(deps.config.missingInterfaces, () => true),
    missingKeys: stringList(deps.config.droppedReadings, (k) => SNAPSHOT_KEYS.indexOf(k) >= 0) as SnapshotKey[],
  });
  const gate = new PowerGate({ clock });

  /** The alerts the screen lists: newest raise or clearing per id, at most LISTED_MAX. */
  let listed: AlertEvent[] = [];
  const list = (event: AlertEvent): void => {
    for (let i = 0; i < listed.length; i++) {
      if (listed[i].id === event.id) {
        listed[i] = event;
        return;
      }
    }
    if (!event.active && !event.title) return;           // a clearing rebuilt after a restart for an alert never listed
    listed.push(event);
    if (listed.length > LISTED_MAX) {
      let drop = 0;
      for (let i = 0; i < listed.length; i++) if (!listed[i].active) { drop = i; break; }
      listed = listed.slice(0, drop).concat(listed.slice(drop + 1));
    }
  };

  const gates = popupGates(() => state.popupsEnabled === true && setting('popups') !== false, () => provider.snapshot());
  const presenter = new AlertPresenter({
    ui: ctx.ui,
    timers,
    log,
    enabled: gates.enabled,
    hold: gates.hold,
    ascii: () => state.asciiPopups === true,
  });

  /* the uplink, with every answer watched: an authorised answer pairs the car, a 401/403 unpairs it */
  let answered = false;
  const http: HttpsClient | null = deps.http || (backendUrl
    ? new HttpsClient({ baseUrl: backendUrl, lease: () => readLease(dataDir || '', dataDir ? fs : NO_DISK), log, timers, clock })
    : null);
  const noteAnswer = safe(log, 'pairing', (authorised: boolean) => {
    if (authorised) {
      answered = true;
      if (!state.paired) {
        state.paired = true;
        log.info('pairing: the backend accepted this car');
        save();
      }
    } else if (state.paired) {
      state.paired = false;
      log.warn('pairing: the backend refused this car; showing the pairing code again');
      save();
    }
  });
  if (http) {
    const request = http.request.bind(http);
    http.request = function watched<T>(method: 'GET' | 'POST', path: string, body: unknown, bearer: string, options?: RequestOptions): Promise<T> {
      return request<T>(method, path, body, bearer, options).then(
        (value) => {
          noteAnswer(true);
          return value;
        },
        (error: unknown) => {
          if (error instanceof UplinkError && error.kind === 'unauthorized') noteAnswer(false);
          throw error;
        },
      );
    };
  }
  const uplink = http ? new UplinkClient({ http, device: () => state.device, clock, log }) : null;

  const runner = new RuleRunner({
    provider,
    engine,
    limits: () => state.limits,
    clock,
    onEvents: (events) => {
      const upload: AlertEvent[] = [];
      let raised = false;
      for (const event of events) {
        list(event);
        // the identical object the runner handed over: its re-opened mark is keyed on object identity
        presenter.present(event);
        if (!uploads(event)) continue;
        upload.push(event);
        if (event.active && !isReopened(event)) raised = true;
      }
      if (!uplink || upload.length === 0) return;
      // a raise goes at once (with what waits before it); clearings and re-openings ride with the next send
      if (raised) uplink.sendAlerts(upload);
      else uplink.queueAlerts(upload);
    },
  });

  /* the dialog shown on the assistant tab */
  let lastTurn: DialogTurn | null = null;
  let lastTurnId: string | null = null;
  let asking = false;
  let error: string | null = null;

  const linkStatus = (): LinkStatus => {
    if (!state.paired) return 'unpaired';
    if (!uplink) return 'offline';
    const status = uplink.status();
    return status === 'ok' && !answered ? 'offline' : status;
  };

  const screenInput = (): ScreenInput => ({
    snapshot: provider.snapshot(),
    alerts: listed,
    lastTurn,
    pending: asking,
    error,
    link: linkStatus(),
    pairUrl: pairingUrl(backendUrl, state.device),
  });

  const screenVisible = (): boolean => {
    try {
      return ctx.ui.isVisible(SCREEN);
    } catch {
      return false;
    }
  };

  const ask = (question: string, moving: boolean): void => {
    if (asking || stopped) return;
    if (!uplink) {
      error = TEXT_NO_SERVER;
      return;
    }
    asking = true;
    error = null;
    uplink.ask(question, moving ? 'spoken' : 'full').then(
      safe(log, 'ask', (turn: DialogTurn) => {
        asking = false;
        if (isTurn(turn)) {
          lastTurn = turn;
          lastTurnId = turn.id;
        }
      }),
      safe(log, 'ask', (failure: unknown) => {
        asking = false;
        error = errorLine(failure);
      }),
    );
  };

  let screen: Screen | null = null;
  try {
    screen = startScreen({ ctx, clock, log, input: screenInput, onChip: ask, has, frame });
  } catch (failure) {
    log.error('screen: ' + (failure instanceof Error ? failure.message : String(failure)));
  }

  /* ---------- the dialog long-poll: issued only while the screen shows and the car is awake ---------- */

  let polling = false;
  let pollGen = 0;
  let pollWait: unknown = null;
  /** Ends the poll that is open now, alone (UplinkClient.pollDialog's cancel handle); null when none is. */
  let pollCancel: (() => void) | null = null;

  const pollAllowed = (): boolean => !!uplink && !stopped && gate.state() !== 'asleep' && screenVisible();

  const takeTurns = (turns: DialogTurn[]): void => {
    if (!Array.isArray(turns) || turns.length === 0) return;
    const last = turns[turns.length - 1];
    if (!isTurn(last)) return;
    lastTurn = last;
    lastTurnId = last.id;
    if (!asking) error = null;
  };

  const waitThenPoll = (): void => {
    if (!pollAllowed() || pollWait !== null) return;
    pollWait = timers.setTimeout(afterWait, POLL_RETRY_MS);
  };

  const pumpPoll = (): void => {
    if (!uplink || !pollAllowed() || polling || pollWait !== null) return;
    polling = true;
    const gen = ++pollGen;
    const issuedAt = clock.now();
    pollCancel = null;
    uplink.pollDialog(lastTurnId, (cancel) => {
      if (gen === pollGen) pollCancel = cancel;
    }).then(
      safe(log, 'dialog poll', (turns: DialogTurn[]) => {
        if (gen !== pollGen) return;
        polling = false;
        pollCancel = null;
        takeTurns(turns);
        const now = clock.now();
        // the server holds an empty poll for 25 s: one answered at once with nothing is not re-issued at once
        const quick = (!Array.isArray(turns) || turns.length === 0) && now >= issuedAt && now - issuedAt < POLL_RETRY_MS;
        if (quick) waitThenPoll();
        else pumpPoll();
      }),
      safe(log, 'dialog poll', () => {
        if (gen !== pollGen) return;
        polling = false;
        pollCancel = null;
        waitThenPoll();
      }),
    );
  };

  const afterWait = safe(log, 'dialog poll', () => {
    pollWait = null;
    pumpPoll();
  });

  /**
   * The screen was hidden, the car fell asleep or the app stopped: a waiting retry is dropped and the poll still
   * open is ended through its own cancel handle (HttpsClient RequestOptions.cancelHandle). That ends this request
   * alone: an alert or snapshot POST in flight, the keep-alive connection of the other requests and the link
   * status are left as they are. Its answer, if one still arrives, is ignored. The next poll starts when the
   * screen shows again.
   */
  const stopPoll = (): void => {
    if (pollWait !== null) {
      timers.clearTimeout(pollWait);
      pollWait = null;
    }
    pollGen++;
    polling = false;
    const cancel = pollCancel;
    pollCancel = null;
    if (cancel !== null) cancel();
  };

  /* ---------- config ---------- */

  let configWanted = true;
  let configBusy = false;
  let configTriedAt: number | null = null;

  const applyConfig = (config: CarConfigResponse): void => {
    const limits = config.ownerLimits;
    const popups = config.popupsEnabled === true;
    const merged = Object.assign({}, state.limits);
    for (const key of Object.keys(merged) as Array<keyof typeof merged>) {
      const v = (limits as unknown as Record<string, unknown>)[key];
      merged[key] = typeof v === 'number' && isFinite(v) ? v : null;
    }
    if (sameJson(merged, state.limits) && popups === state.popupsEnabled) return;
    state.limits = merged;
    state.popupsEnabled = popups;
    save();
  };

  const maybeFetchConfig = safe(log, 'config', (): void => {
    if (!uplink || !http || !configWanted || configBusy || stopped || gate.state() === 'asleep') return;
    const now = clock.now();
    if (configTriedAt !== null && now >= configTriedAt && now - configTriedAt < CONFIG_RETRY_MS) return;
    if (!http.online()) return;
    configBusy = true;
    configTriedAt = now;
    uplink.fetchConfig().then(
      safe(log, 'config', (config: CarConfigResponse) => {
        configBusy = false;
        configWanted = false;
        applyConfig(config);
      }),
      safe(log, 'config', () => {
        configBusy = false;
      }),
    );
  });

  /* ---------- the tick ---------- */

  let tickHandle: unknown = null;
  let lastSnapshotAt: number | null = null;
  let lastRetryAt: number | null = null;
  let sample: Sample | null = null;

  const stepRules = safe(log, 'rules', () => runner.tick());
  const stepGate = safe(log, 'power gate', () => {
    gate.update(provider.snapshot());
  });
  const stepUplink = safe(log, 'uplink tick', () => {
    if (!uplink) return;
    const now = clock.now();
    if (lastSnapshotAt === null || now < lastSnapshotAt || now - lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
      lastSnapshotAt = now;
      uplink.recordSnapshot(provider.snapshot());
    }
    uplink.onTick(gate.state());
    maybeFetchConfig();
    if (!state.paired && screenVisible() && (lastRetryAt === null || now < lastRetryAt || now - lastRetryAt >= PAIRING_RETRY_MS)) {
      lastRetryAt = now;
      uplink.retry();
    }
  });
  const stepMeasure = safe(log, 'self-measure', () => {
    const r = measure(sample, clock.now(), () => process.memoryUsage(), () => process.cpuUsage());
    sample = r.sample;
    if (r.line) log.info(r.line);
  });

  const tick = safe(log, 'tick', () => {
    if (stopped) return;
    stepRules();
    stepGate();
    if (gate.state() === 'asleep' || stopped) return;
    stepUplink();
    stepMeasure();
  });

  const startTick = (): void => {
    if (tickHandle === null && !stopped) tickHandle = timers.setInterval(tick, TICK_MS);
  };
  const stopTick = (): void => {
    if (tickHandle !== null) {
      timers.clearInterval(tickHandle);
      tickHandle = null;
    }
  };

  /* ---------- power ---------- */

  const fallAsleep = (): void => {
    stopTick();
    presenter.closeAll();
    stopPoll();
    if (uplink) uplink.close();
    answered = false;
    provider.suspend();
    save();
  };

  const wakeUp = (): void => {
    provider.resume();
    if (uplink) {
      uplink.reopen();
      uplink.retry();
    }
    configWanted = true;
    configTriedAt = null;
    lastRetryAt = clock.now();
    startTick();
    maybeFetchConfig();
    pumpPoll();
  };

  gate.onChange(safe(log, 'power', (next: PowerState, previous: PowerState) => {
    log.info('power: ' + previous + ' -> ' + next);
    if (next === 'asleep') fallAsleep();
    else if (previous === 'asleep') wakeUp();
  }));

  // asleep, no tick runs: a condition change (the suspended provider notifies it) is the only way back
  provider.onChange((snapshot: VehicleSnapshot) => {
    if (!stopped && gate.state() === 'asleep') gate.update(snapshot);
  });

  ctx.ui.onVisible(safe(log, 'visible', (name: string, on: boolean) => {
    if (name !== SCREEN || stopped) return;
    if (on) pumpPoll();
    else stopPoll();
  }));

  let testPopupOn = setting(TEST_POPUP_SETTING) === true;

  ctx.settings.onChange(safe(log, 'settings', (key: string, value: unknown) => {
    if (key === TEST_POPUP_SETTING) {
      const on = value === true;
      const turnedOn = on && !testPopupOn;
      testPopupOn = on;
      // only awake: asleep, the presenter must start no timer (and the screen is dark)
      if (turnedOn && !stopped && gate.state() !== 'asleep') presenter.presentText(TEST_POPUP_ID, TEXT_TEST_POPUP);
      return;
    }
    if (key !== 'latinPopups') return;
    const ascii = value === true;
    if (ascii === state.asciiPopups) return;
    state.asciiPopups = ascii;
    save();
  }));

  /* ---------- start ---------- */

  const version = ctx.spec && typeof ctx.spec.version === 'string' ? ctx.spec.version : '?';
  const reason = ctx.app && typeof (ctx.app as { startReason?: unknown }).startReason === 'string' ? (ctx.app as { startReason: string }).startReason : 'unknown';
  log.info('Copilot ' + version + ' on Node ' + process.version + ', start reason ' + reason + (backendUrl ? '' : ', no backend address'));

  if (typeof ctx.background === 'function') safe(log, 'background', () => ctx.background('monitor', true))();
  safe(log, 'provider start', () => provider.start())();
  startTick();
  maybeFetchConfig();
  pumpPoll();

  return {
    stop(): void {
      stopped = true;
      stopTick();
      stopPoll();
      presenter.closeAll();
      if (screen) screen.stop();
      if (uplink) uplink.close();
      safe(log, 'provider stop', () => provider.stop())();
    },
    persist(): void {
      saveIfChanged();
    },
    inspect() {
      return {
        power: gate.state(),
        queued: uplink ? uplink.queued() : { snapshots: 0, alerts: 0 },
        history: engine.history().length,
        screen: screenInput(),
      };
    },
  };
}
