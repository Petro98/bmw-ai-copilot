/**
 * The head-unit app, wired (Plan 2 Task 9): state file → vehicle provider → power gate → rule runner (with the
 * shared event engine) → BMW pop-up presenter → uplink → screen. car/src/main.ts calls startApp once from the
 * kit's start(ctx); everything here is injected, so it runs unchanged against a fake kit in car/src/app.test.ts.
 *
 * Power (spec §9, car/src/power/power-gate.ts):
 *   - awake or driving: exactly one 1000 ms interval. Each tick refreshes the provider and runs the rules
 *     (RuleRunner.tick), updates the power gate, keeps a snapshot for the uplink once a minute, lets the uplink
 *     send what is due, and self-measures (a line at most every ten minutes).
 *   - asleep: none of the app's timers. The tick stops, the pop-up presenter closes everything, the dialog poll
 *     ends, the uplink closes (it refuses everything until reopened), the provider is suspended (only its passive
 *     vehicle-condition watch stays) and the state file is written if anything in it changed. The kit's screen
 *     loop and its renderer keep-alive are not the app's: they follow the screen's visibility, not the power
 *     gate, so they keep running for as long as the head unit reports the app's screen shown. A visibility
 *     change while asleep is logged (info), so the owner's car check can see whether the screen is hidden.
 *   - the way back: a condition notification (the suspended provider notifies its listeners for it, and the
 *     listener updates the gate), or the owner using the app — a question asked, the screen shown, or the
 *     pairing panel on screen (each tick) — which restarts the gate's idle fallback (PowerGate.touch). A car that
 *     reports parked or standby stays asleep: only the fallback, taken when the condition is unknown or stale,
 *     gives way to use.
 *   - waking: the provider resumes, the uplink reopens and lifts a refusal block (retry), the tick starts again,
 *     the car's config (owner limits, the phone's pop-up switch) is fetched once when online.
 *
 * Failed requests back off: after a failure the dialog poll waits POLL_RETRY_MS and the config fetch
 * CONFIG_RETRY_MS, each wait doubling with every further failure up to RETRY_MAX_MS, and starting over on
 * waking and on any request the backend answers (a poll waiting out a longer step is then issued at once). A
 * poll refused locally as `offline` (no lease: nothing was sent) is no failure of the link: it waits the first
 * step again. While the pairing panel shows, a pairing retry (every 30 s) tries the poll at once whatever
 * failed before, so registering on the phone is seen within half a minute.
 *
 * A wrong head-unit clock (a request failed because the server's certificate is not valid at this time) is
 * shown as soon as it is known: on the pairing panel in place of its instructions, or in the assistant tab's
 * answer area (ScreenInput.clockWrong). It is logged once per waking period, forgotten on waking (the first
 * request then finds it again) and cleared by any request the backend answers.
 *
 * Pairing: the car makes up its device id and secret on its first run (`random`). The pairing panel (a QR code
 * of the phone's /pair address) shows until the backend has answered a request from this device as authorised;
 * that fact is kept in the state file (`paired`), and a 401/403 later clears it. Before any request has been
 * answered in this waking period the network marks never read as working.
 *
 * Alerts to the phone: a raised `critical` or `warning` alert is sent at once; its clearing and a re-opening (both
 * under the id of the raise) are queued and go with the next raise or the next minute's batch (UplinkClient
 * queueAlerts), so the car link stays within its once-a-minute budget. What the uplink has not delivered (an alert
 * send in flight and its queue) rides along in every state write (`pendingAlerts`; it never causes a write of its own) and is queued again
 * once when the next process starts, so a clearing queued while offline is not lost with the process. The backend has no rules of its own when
 * the car is the vehicle source: without these, an alert the car raised would never clear on the phone. `info`
 * alerts stay on the car, and so do their clearings, except a clearing rebuilt after a restart (severity 'info',
 * empty title), whose original severity is unknown.
 *
 * The owner's test switch «Тестове сповіщення» (settings key `testPopup`): turning it on (off to on) shows one
 * pop-up «Тестове сповіщення Copilot» through the presenter, with the same gates as an alert, and nothing is
 * listed, kept or sent. The app cannot turn the switch back off (our code has no settings writer: kit.d.ts), so
 * it fires once per off-to-on change. While asleep it does nothing.
 *
 * Writes (spec §9): the state file is written when the car falls asleep (only if something changed), when the
 * device is created, when pairing changes, when the owner's settings or the fetched config change, and when a
 * `critical` or `warning` alert is raised (at once; the engine's global rate limit bounds these) or cleared (at
 * most once per ALERT_SAVE_GAP_MS, a clearing inside that gap is written by the first tick after it), so a
 * restart in the middle of a drive, even one without a clean exit, keeps the alert memory. persist() writes it
 * only if something changed since the last write; main.ts calls it when the process exits. A failed write is
 * not counted as saved, so the next chance writes it again. The device secret is never logged.
 *
 * A question asked while the car is not driving (no minute batches then) carries the car's current snapshot,
 * which the uplink sends alone just before it, so the answer is built from the readings of now and not from the
 * last drive's upload. Turns from the backend are checked (string id, question and answer) and their text cut to
 * TURN_TEXT_MAX before they are kept or drawn.
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
import { TEXT_CLOCK, TEXT_TEST_POPUP } from './ui/strings.uk';
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
/** After a failed dialog poll (or one answered at once with nothing), the next one waits this long (the first step). */
export const POLL_RETRY_MS = 5000;
/** While the pairing panel is shown, a refused device is tried again at most this often. */
export const PAIRING_RETRY_MS = 30_000;
/** A config fetch that failed is tried again after this long while awake (the first step). */
export const CONFIG_RETRY_MS = 60_000;
/** Each further failure doubles the wait of the dialog poll and of the config fetch, up to this. */
export const RETRY_MAX_MS = 600_000;
/** Alert clearings reach the state file at most this often (a raise is written at once). */
export const ALERT_SAVE_GAP_MS = 60_000;
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

/** The Ukrainian error lines on the assistant tab (plan 2 Task 9); TEXT_CLOCK lives in ui/strings.uk.ts. */
export const TEXT_NO_SERVER = 'Немає зв\'язку з сервером';
export { TEXT_CLOCK };
export const TEXT_REFUSED = 'Сервер відхилив запит';

/** The wait after `failures` failures in a row: `first`, doubled for each further one, at most RETRY_MAX_MS. */
function backoff(first: number, failures: number): number {
  let wait = first;
  for (let i = 1; i < failures && wait < RETRY_MAX_MS; i++) wait *= 2;
  return Math.min(wait, RETRY_MAX_MS);
}

/**
 * The line for a failed question: the server reached but answering with a refusal or an error (4xx, 5xx, a reset
 * connection, a reply of the wrong shape) is «Сервер відхилив запит»; no network, a resolver, TLS or timeout
 * failure is «Немає зв'язку з сервером»; a wrong clock has its own line.
 */
function errorLine(error: unknown): string {
  const kind = error instanceof UplinkError ? error.kind : null;
  if (kind === 'clock') return TEXT_CLOCK;
  if (kind === 'unauthorized' || kind === 'client-error' || kind === 'server-error') return TEXT_REFUSED;
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

/** A turn's question and answer are cut to this many characters (the screen shows eight lines of the answer). */
export const TURN_TEXT_MAX = 2000;
/** A turn id longer than this is refused (it is sent back in the poll's query, so it is never cut). */
export const TURN_ID_MAX = 128;

function cutText(text: string): string {
  return text.length > TURN_TEXT_MAX ? text.slice(0, TURN_TEXT_MAX) : text;
}

/** A checked copy of a turn from the backend, its text cut to TURN_TEXT_MAX; null when it is not a turn. */
function turnFrom(v: unknown): DialogTurn | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== 'string' || t.id === '' || t.id.length > TURN_ID_MAX) return null;
  if (typeof t.question !== 'string' || typeof t.answer !== 'string') return null;
  return {
    id: t.id,
    at: typeof t.at === 'number' && isFinite(t.at) ? t.at : 0,
    question: cutText(t.question),
    answer: cutText(t.answer),
    style: t.style === 'spoken' ? 'spoken' : 'full',
    source: t.source === 'panel' || t.source === 'voice' ? t.source : 'car',
    model: typeof t.model === 'string' ? t.model.slice(0, TURN_ID_MAX) : '',
    snapshotAt: typeof t.snapshotAt === 'number' && isFinite(t.snapshotAt) ? t.snapshotAt : null,
  };
}

/** Whether an event goes to the phone: raised alerts the car pops up, and every later state of those. */
function uploads(event: AlertEvent): boolean {
  if (event.severity === 'critical' || event.severity === 'warning') return true;
  // a clearing rebuilt after a restart carries severity 'info' and an empty title (rule-runner.ts restoredClearing).
  // Its original severity is not kept anywhere, so it is sent even when the raise was an info alert the phone never
  // got: the backend ignores a clearing for an id it does not know, so that upload is harmless.
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
  // the alerts the last process had not delivered: queued again once the uplink exists; from then on the uplink
  // holds them, and every write carries its copy (pendingAlerts below)
  const restoredAlerts: AlertEvent[] = Array.isArray(state.pendingAlerts) ? state.pendingAlerts : [];
  state.pendingAlerts = undefined;
  /** What the uplink has not delivered; set once the uplink exists (before that, what the file held). */
  let pendingAlerts = (): AlertEvent[] => restoredAlerts;
  const latin = setting('latinPopups');
  if (typeof latin === 'boolean') state.asciiPopups = latin;

  const engine = new EventEngine(defaultEngineOptions());
  try {
    engine.restore(state.engine);
  } catch {
    log.warn('state file: engine memory not restored, starting clean');
  }

  let lastSaved = '';
  /** The state as compared for a change: the unsent alerts are left out, so they never cause a write of their own. */
  const snapshotOfState = (): string => {
    state.engine = engine.state();
    return JSON.stringify(state);
  };
  const save = (): void => {
    let current: string;
    try {
      current = snapshotOfState();
    } catch {
      current = '';
    }
    let pending: AlertEvent[];
    try {
      pending = pendingAlerts();
    } catch {
      pending = [];
    }
    // a failed write is not counted as saved: saveIfChanged() then writes it again at the next chance
    lastSaved = stateFile.save(Object.assign({}, state, { pendingAlerts: pending })) ? current : '';
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

  /**
   * The owner used the app (a question, the screen shown, the pairing panel on screen): restarts the idle fallback
   * and lets the gate decide again, so a quiet car that idled asleep wakes; a car reporting parked stays asleep.
   */
  const noteUse = safe(log, 'power gate', (): void => {
    if (stopped) return;
    gate.touch();
    gate.update(provider.snapshot());
  });

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
  /** The last request failed because the head unit's clock is wrong; an answer from the backend clears it. */
  let clockWrong = false;
  let clockLogged = false;
  /** Called on every answer from the backend (set below, once the config fetch exists). */
  let onAnswered: () => void = () => undefined;
  const answeredStep = safe(log, 'answered', () => onAnswered());
  const noteClock = safe(log, 'clock', (wrong: boolean) => {
    clockWrong = wrong;
    if (wrong && !clockLogged) {
      clockLogged = true;
      log.warn('uplink: the head unit\'s clock is wrong (the server\'s certificate is not valid at this time); every request fails until it is set right');
    }
  });
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
          noteClock(false);
          noteAnswer(true);
          answeredStep();
          return value;
        },
        (error: unknown) => {
          if (error instanceof UplinkError && error.kind === 'clock') noteClock(true);
          if (error instanceof UplinkError && error.kind === 'unauthorized') {
            noteClock(false);                                   // a 401 came back over TLS: the clock is fine
            noteAnswer(false);
          }
          throw error;
        },
      );
    };
  }
  const uplink = http ? new UplinkClient({ http, device: () => state.device, clock, log }) : null;
  if (uplink) {
    uplink.queueAlerts(restoredAlerts);
    pendingAlerts = () => uplink.pendingAlerts();
  }

  let alertSaveDue = false;
  let alertSavedAt: number | null = null;
  /** Writes the alert memory: a raise at once, a clearing at most once per ALERT_SAVE_GAP_MS (else by a later tick). */
  const saveAlertMemory = (now: boolean): void => {
    const at = clock.now();
    if (!now && alertSavedAt !== null && at >= alertSavedAt && at - alertSavedAt < ALERT_SAVE_GAP_MS) {
      alertSaveDue = true;
      return;
    }
    alertSaveDue = false;
    alertSavedAt = at;
    saveIfChanged();
  };

  const runner = new RuleRunner({
    provider,
    engine,
    limits: () => state.limits,
    clock,
    onEvents: (events) => {
      const upload: AlertEvent[] = [];
      let raised = false;
      let cleared = false;
      for (const event of events) {
        list(event);
        // the identical object the runner handed over: its re-opened mark is keyed on object identity
        presenter.present(event);
        if (!uploads(event)) continue;
        upload.push(event);
        if (event.active && !isReopened(event)) raised = true;
        if (!event.active) cleared = true;
      }
      // a raise goes at once (with what waits before it); clearings and re-openings ride with the next send.
      // Handed over before the write below, so that write carries them while they are undelivered.
      if (uplink && upload.length > 0) {
        if (raised) uplink.sendAlerts(upload);
        else uplink.queueAlerts(upload);
      }
      // the alert memory reaches the disk now, so a restart mid-drive (even a killed process) does not repeat it
      if (raised || cleared) saveAlertMemory(raised);
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
    clockWrong,
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
    noteUse();
    if (!uplink) {
      error = TEXT_NO_SERVER;
      return;
    }
    asking = true;
    error = null;
    // not driving, no minute batch keeps the backend current: the question carries the readings of now
    let current: VehicleSnapshot | undefined;
    try {
      current = gate.state() === 'driving' ? undefined : provider.snapshot();
    } catch {
      current = undefined;
    }
    uplink.ask(question, moving ? 'spoken' : 'full', current).then(
      safe(log, 'ask', (reply: DialogTurn) => {
        asking = false;
        const turn = turnFrom(reply);
        if (turn !== null) {
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
  /** Failed polls in a row (the wait before the next one doubles with each). */
  let pollFailures = 0;
  /**
   * Answered polls in a row whose newest turn was refused (turnFrom). Kept apart from pollFailures, which every
   * answer from the backend resets: the link works, the reply does not, and the same `after` would bring the same
   * turn back at once.
   */
  let pollRefusals = 0;
  /** Ends the poll that is open now, alone (UplinkClient.pollDialog's cancel handle); null when none is. */
  let pollCancel: (() => void) | null = null;

  const pollAllowed = (): boolean => !!uplink && !stopped && gate.state() !== 'asleep' && screenVisible();

  /** Keeps the newest turn of a poll reply; false when the reply had turns but the newest was refused. */
  const takeTurns = (turns: DialogTurn[]): boolean => {
    if (!Array.isArray(turns) || turns.length === 0) return true;
    // only the newest is kept and drawn
    const last = turnFrom(turns[turns.length - 1]);
    if (last === null) return false;
    lastTurn = last;
    lastTurnId = last.id;
    if (!asking) error = null;
    return true;
  };

  const waitThenPoll = (ms: number): void => {
    if (!pollAllowed() || pollWait !== null) return;
    pollWait = timers.setTimeout(afterWait, ms);
  };

  /** Drops a waiting retry and issues the poll now (when allowed and none is open). */
  const pollNow = (): void => {
    if (polling) return;
    if (pollWait !== null) {
      timers.clearTimeout(pollWait);
      pollWait = null;
    }
    pumpPoll();
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
        pollFailures = 0;
        if (!takeTurns(turns)) {
          // nothing taken and `after` unchanged: re-issuing at once would bring the same turn back at network speed
          if (pollRefusals === 0) log.warn('dialog poll: the newest turn from the backend was refused (wrong shape)');
          if (pollRefusals < 64) pollRefusals++;
          waitThenPoll(backoff(POLL_RETRY_MS, pollRefusals));
          return;
        }
        pollRefusals = 0;
        const now = clock.now();
        // the server holds an empty poll for 25 s: one answered at once with nothing is not re-issued at once
        const quick = (!Array.isArray(turns) || turns.length === 0) && now >= issuedAt && now - issuedAt < POLL_RETRY_MS;
        if (quick) waitThenPoll(POLL_RETRY_MS);
        else pumpPoll();
      }),
      safe(log, 'dialog poll', (failure: unknown) => {
        if (gen !== pollGen) return;
        polling = false;
        pollCancel = null;
        // refused locally for want of a lease: nothing was sent, so it is no failure of the link to back off from
        if (failure instanceof UplinkError && failure.kind === 'offline') {
          waitThenPoll(POLL_RETRY_MS);
          return;
        }
        if (pollFailures < 64) pollFailures++;
        waitThenPoll(backoff(POLL_RETRY_MS, pollFailures));
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
  /** Failed config fetches in a row (the wait before the next one doubles with each). */
  let configFailures = 0;

  // any answer from the backend shows the link works: the poll's back-off starts over (a poll waiting out a
  // longer step goes now), and a config fetch still wanted goes at the next tick
  onAnswered = () => {
    if (pollFailures > 0) {
      pollFailures = 0;
      if (pollWait !== null) pollNow();
    }
    if (configWanted && !configBusy && configFailures > 0) {
      configFailures = 0;
      configTriedAt = null;
    }
  };

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
    if (configTriedAt !== null && now >= configTriedAt && now - configTriedAt < backoff(CONFIG_RETRY_MS, configFailures)) return;
    if (!http.online()) return;
    configBusy = true;
    configTriedAt = now;
    uplink.fetchConfig().then(
      safe(log, 'config', (config: CarConfigResponse) => {
        configBusy = false;
        configWanted = false;
        configFailures = 0;
        applyConfig(config);
      }),
      safe(log, 'config', () => {
        configBusy = false;
        if (configFailures < 64) configFailures++;
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
      const refused = uplink.status() === 'unpaired';
      uplink.retry();
      // try the poll now rather than after its back-off, whatever failed before (a refusal, the resolver, the
      // clock), so a device the owner has just registered on the phone is seen within PAIRING_RETRY_MS (one
      // request per retry); a refusal lifted by retry() also starts the back-off over
      if (refused) pollFailures = 0;
      pollNow();
    }
  });
  const stepAlertSave = safe(log, 'state file', () => {
    if (alertSaveDue) saveAlertMemory(false);
  });
  const stepMeasure = safe(log, 'self-measure', () => {
    const r = measure(sample, clock.now(), () => process.memoryUsage(), () => process.cpuUsage());
    sample = r.sample;
    if (r.line) log.info(r.line);
  });

  const tick = safe(log, 'tick', () => {
    if (stopped) return;
    stepRules();
    // the pairing panel on screen is the owner setting the car up: it does not idle out
    if (!state.paired && screenVisible()) gate.touch();
    stepGate();
    if (gate.state() === 'asleep' || stopped) return;
    stepUplink();
    stepAlertSave();
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
    alertSaveDue = false;
    saveIfChanged();
  };

  const wakeUp = (): void => {
    provider.resume();
    if (uplink) {
      uplink.reopen();
      uplink.retry();
    }
    configWanted = true;
    configTriedAt = null;
    configFailures = 0;
    pollFailures = 0;
    pollRefusals = 0;
    // the clock is judged afresh by the first request of this waking period, and logged again if still wrong
    clockWrong = false;
    clockLogged = false;
    // the first self-measurement after a wake takes a baseline: it never averages over the time asleep
    sample = null;
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

  // asleep, no tick runs: a condition notification (the suspended provider notifies it) wakes the app, as does
  // the owner using it (noteUse)
  provider.onChange((snapshot: VehicleSnapshot) => {
    if (!stopped && gate.state() === 'asleep') gate.update(snapshot);
  });

  ctx.ui.onVisible(safe(log, 'visible', (name: string, on: boolean) => {
    if (name !== SCREEN || stopped) return;
    if (on) noteUse();
    // the kit's screen loop follows the visibility, not the gate: say so while asleep (the owner's car check)
    if (gate.state() === 'asleep') log.info('screen: ' + (on ? 'shown' : 'hidden') + ' while asleep');
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
