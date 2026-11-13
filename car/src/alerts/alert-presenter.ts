/**
 * BMW's small pop-up for `critical` and `warning` alerts (spec §6.4, §7): one at a time, shown after a settle
 * delay so BMW's own message appears first, closing by itself after POPUP_VISIBLE_MS or on its OK button,
 * never while reversing, and not at all when the owner switched pop-ups off. `info` events, cleared events
 * and re-opened events (rule-runner.ts markReopened) never pop up.
 *
 * Two different reasons keep a pop-up off the screen, and they are handled differently:
 *   - `enabled()` false (the owner's switch, spec §7 "list only"): waiting pop-ups are dropped.
 *   - `hold()` true (reversing, spec §6.4): waiting pop-ups are kept and shown once the hold ends, because the
 *     engine raises an alert only once while it stays active and would give no second chance. A pop-up that
 *     is up when the hold starts closes within POPUP_CHECK_MS and goes back to the queue once.
 *
 * Kit calls, confirmed in the vendored kit:
 *   - car/kit/runtime/mgu.js:196 `open(stateName)` → rhmi.openState, :197 `close(stateName)` → rhmi.closeState,
 *     :165 `text(name, text)` (non-ASCII text goes through the kit's StringBundle, car/kit/runtime/hmi-text.js),
 *     :192 `onClick(name, fn)` (the handler's rejection is caught and logged by the kit). Each of open, close
 *     and text goes through the kit's _try (mgu.js:159-163): a rejection is logged and resolved, and a call the
 *     HMI does not answer resolves after 4 s, so a pop-up never hangs on the HMI.
 *   - car/kit/tools/build.py:296-315 builds each app.json "popups" entry as a container named <name> with a
 *     label <name>_TEXT and a button <name>_OK; car/apps/p98_copilot/app.json names ours ALERT_POP.
 *   - The order open, then text is required: text sent before the open is refused (INVALID_MODELID),
 *     .research/jap_sysmon_main.js:88-89.
 *   - Priority: build.py writes no pop-up priority property for a "popups" entry (the container gets only
 *     type, widget and stackConsumer="false", build.py:312), and mgu.js has no call to set one, so the kit
 *     exposes none and ours keeps the HMI's default. Whether BMW's own messages still win is car check B11.
 */
import type { AlertEvent } from '@copilot/event-engine';
import { isReversing, type TimerApi, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { Log } from '../safe';
import { safe } from '../safe';
import { POPUP_TEXT_MAX, cutAtWord, popupText } from './alert-text';
import { isReopened } from './rule-runner';
import { toAscii } from './translit';

/** The kit's pop-up and label calls our code uses (car/kit/runtime/mgu.js Ui). */
export interface UiApi {
  open(name: string): Promise<unknown>;
  close(name: string): Promise<unknown>;
  text(name: string, text: string): Promise<unknown>;
  onClick(name: string, fn: () => void): void;
}

/** The pop-up container in app.json "popups". */
export const POPUP_STATE = 'ALERT_POP';
/** Its text label (build.py: <name>_TEXT). */
export const POPUP_TEXT_LABEL = POPUP_STATE + '_TEXT';
/** Its OK button (build.py: <name>_OK). */
export const POPUP_OK_BUTTON = POPUP_STATE + '_OK';

/** A pop-up closes by itself after this long. */
export const POPUP_VISIBLE_MS = 8000;
/** At most this many pop-ups wait while one is shown. */
export const POPUP_QUEUE_MAX = 3;
/**
 * Wait before a pop-up opens, so BMW's own message (and the car's text for it) comes first (spec §7 "a short
 * settle delay"). 4 s is the settle M-Copilot used before relaying a Check Control message:
 * .research/reports/mcopilot.md [background-prior-art] ("4 s settle so warning texts can arrive",
 * C:apps/m_copilot/main.js@ba1560f:335-336).
 */
export const POPUP_SETTLE_MS = 4000;
/**
 * While a pop-up is up, whether it may stay (switched off, reverse engaged) is checked this often; while a
 * waiting pop-up is held back (reversing), whether the hold has ended is checked this often.
 */
export const POPUP_CHECK_MS = 1000;

type PresenterTimers = TimerApi & { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };

export interface AlertPresenterOptions {
  ui: UiApi;
  timers: PresenterTimers;
  log: Log;
  /** The owner's pop-up switch. False drops waiting pop-ups. Read at every step; a throw counts as false. */
  enabled: () => boolean;
  /** Send the text as ASCII (the pop-up widget cannot draw Cyrillic on this unit). */
  ascii: () => boolean;
  /**
   * Pop-ups must wait now (reversing). True keeps waiting pop-ups for later. Read at every step; a throw
   * counts as true. Omitted: never held. The app passes popupGates(...).hold.
   */
  hold?: () => boolean;
}

/**
 * The two predicates the app gives the presenter: `enabled` is the owner's pop-up switch (a failure reading
 * it counts as off); `hold` is true while reversing (spec §6.4 "none while reversing"; isReversing is true
 * only for a known gear stage R), and a failure reading the snapshot also holds, since it cannot be told
 * that the car is not reversing.
 */
export function popupGates(
  switchOn: () => boolean,
  snapshot: () => VehicleSnapshot,
): { enabled: () => boolean; hold: () => boolean } {
  return {
    enabled: () => {
      try {
        return switchOn() === true;
      } catch {
        return false;
      }
    },
    hold: () => {
      try {
        return isReversing(snapshot());
      } catch {
        return true;
      }
    },
  };
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1 };

/** A waiting pop-up; `interrupted` once it was closed by a hold and put back (it is put back only once). */
interface Waiting {
  event: AlertEvent;
  interrupted: boolean;
}

type Phase = 'idle' | 'settling' | 'showing';

export class AlertPresenter {
  private readonly ui: UiApi;
  private readonly timers: PresenterTimers;
  private readonly log: Log;
  private readonly enabled: () => boolean;
  private readonly ascii: () => boolean;
  private readonly hold: (() => boolean) | null;
  /** Waiting pop-ups, most severe first, oldest first within a severity; at most POPUP_QUEUE_MAX. */
  private queue: Waiting[] = [];
  private phase: Phase = 'idle';
  /** The settle (or hold re-check) timeout while settling; the check interval while showing. */
  private timer: unknown = null;
  /** The pop-up shown now (or opening). */
  private current: Waiting | null = null;
  /** Time the current pop-up has been up, in POPUP_CHECK_MS steps. */
  private shownMs = 0;
  /** Bumped whenever a pop-up ends: a late answer from the HMI for an earlier one is recognised by it. */
  private generation = 0;
  private readonly onSettled: () => void;
  private readonly onCheck: () => void;

  constructor(options: AlertPresenterOptions) {
    this.ui = options.ui;
    this.timers = options.timers;
    this.log = options.log;
    this.enabled = options.enabled;
    this.ascii = options.ascii;
    this.hold = typeof options.hold === 'function' ? options.hold : null;
    this.onSettled = safe(this.log, 'popup settle', () => this.settled());
    this.onCheck = safe(this.log, 'popup check', () => this.check());
    try {
      this.ui.onClick(POPUP_OK_BUTTON, safe(this.log, 'popup ok', () => this.finish()));
    } catch (error) {
      this.warn('popup onClick', error);
    }
  }

  /** Queues a critical or warning event for a pop-up; anything else is ignored. Never throws. */
  present(event: AlertEvent): void {
    try {
      if (!event || event.active !== true || isReopened(event)) return;
      if (event.severity !== 'critical' && event.severity !== 'warning') return;
      if (!this.allowed()) return;
      if (this.current && this.current.event.id === event.id) return;
      for (const queued of this.queue) if (queued.event.id === event.id) return;
      this.enqueue({ event, interrupted: false });
      this.pump();
    } catch (error) {
      this.warn('popup present', error);
    }
  }

  /** Closes the pop-up if one is up, drops every waiting one and leaves no timer. Never throws. */
  closeAll(): void {
    try {
      this.queue = [];
      if (this.phase === 'showing') {
        this.end();
      } else {
        this.stopTimer();
        this.phase = 'idle';
      }
    } catch (error) {
      this.warn('popup closeAll', error);
    }
  }

  /* ---------- internals ---------- */

  private allowed(): boolean {
    try {
      return this.enabled() === true;
    } catch {
      return false;
    }
  }

  /** True while a hold (reversing) keeps pop-ups back; a throw counts as held. */
  private held(): boolean {
    if (this.hold === null) return false;
    try {
      return this.hold() === true;
    } catch {
      return true;
    }
  }

  /**
   * Inserts by severity (FIFO within one; an interrupted pop-up goes first within its severity, it is the
   * oldest); beyond the cap the oldest of the least severe waiting is dropped.
   */
  private enqueue(item: Waiting): void {
    const rank = SEVERITY_RANK[item.event.severity];
    let at = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      const other = SEVERITY_RANK[this.queue[i].event.severity];
      if (other > rank || (item.interrupted && other === rank)) {
        at = i;
        break;
      }
    }
    this.queue.splice(at, 0, item);
    if (this.queue.length > POPUP_QUEUE_MAX) {
      const worst = SEVERITY_RANK[this.queue[this.queue.length - 1].event.severity];
      let drop = this.queue.length - 1;
      for (let i = 0; i < this.queue.length; i++) {
        if (SEVERITY_RANK[this.queue[i].event.severity] === worst) {
          drop = i;
          break;
        }
      }
      this.queue.splice(drop, 1);
    }
  }

  /** When nothing is shown or settling and something waits, starts the settle delay. */
  private pump(): void {
    if (this.phase !== 'idle' || this.queue.length === 0) return;
    this.phase = 'settling';
    this.timer = this.timers.setTimeout(this.onSettled, POPUP_SETTLE_MS);
  }

  /** The settle delay is over (or a hold re-check is due): switched off → drop; held → wait; else show. */
  private settled(): void {
    this.timer = null;
    if (this.phase !== 'settling') return;
    if (!this.allowed()) {
      this.phase = 'idle';
      this.queue = [];
      return;
    }
    if (this.queue.length > 0 && this.held()) {
      // stay in 'settling' with one re-check timeout; closeAll() clears it
      this.timer = this.timers.setTimeout(this.onSettled, POPUP_CHECK_MS);
      return;
    }
    this.phase = 'idle';
    const item = this.queue.shift();
    if (item) this.show(item);
  }

  private show(item: Waiting): void {
    const generation = ++this.generation;
    this.phase = 'showing';
    this.current = item;
    this.shownMs = 0;
    this.timer = this.timers.setInterval(this.onCheck, POPUP_CHECK_MS);
    const text = this.textOf(item.event);
    const stale = () => generation !== this.generation;
    this.call('open', () => this.ui.open(POPUP_STATE))
      .then(() => {
        if (stale()) {
          // the pop-up ended while the HMI was still opening it: make sure it does not stay up
          return this.call('close', () => this.ui.close(POPUP_STATE)).then(() => undefined);
        }
        return this.call('text', () => this.ui.text(POPUP_TEXT_LABEL, text)).then(() => undefined);
      })
      .then(undefined, (error: unknown) => {
        this.warn('popup', error);
        if (!stale()) this.finish();
      });
  }

  /** Runs a ui call; a throw becomes a rejection. */
  private call(what: string, fn: () => Promise<unknown>): Promise<unknown> {
    try {
      return Promise.resolve(fn()).then(undefined, (error: unknown) => {
        throw new Error(what + ': ' + describe(error));
      });
    } catch (error) {
      return Promise.reject(new Error(what + ': ' + describe(error)));
    }
  }

  private textOf(event: AlertEvent): string {
    const text = popupText(event);
    let ascii: boolean;
    try {
      ascii = this.ascii() === true;
    } catch {
      ascii = false;
    }
    return ascii ? cutAtWord(toAscii(text), POPUP_TEXT_MAX) : text;
  }

  /**
   * Every POPUP_CHECK_MS while a pop-up is up: close it when its time is over, when pop-ups were switched off
   * (the queue is dropped), or when a hold started (it goes back to the queue once and waits with the rest).
   */
  private check(): void {
    if (this.phase !== 'showing') return;
    this.shownMs += POPUP_CHECK_MS;
    if (!this.allowed()) {
      this.queue = [];
      this.finish();
      return;
    }
    if (this.held()) {
      const interrupted = this.current;
      if (interrupted && !interrupted.interrupted) this.enqueue({ event: interrupted.event, interrupted: true });
      this.finish();
      return;
    }
    if (this.shownMs >= POPUP_VISIBLE_MS) this.finish();
  }

  /** The current pop-up ends (time, OK, a failed ui call, switched off, held); the next one starts settling. */
  private finish(): void {
    if (this.phase !== 'showing') return;
    this.end();
    this.pump();
  }

  /** Closes the current pop-up and returns to idle. */
  private end(): void {
    this.stopTimer();
    this.generation++;
    this.current = null;
    this.phase = 'idle';
    this.call('close', () => this.ui.close(POPUP_STATE)).then(undefined, (error: unknown) => this.warn('popup', error));
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    if (this.phase === 'settling') this.timers.clearTimeout(this.timer);
    else this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  private warn(label: string, error: unknown): void {
    try {
      this.log.warn(label + ': ' + describe(error));
    } catch {
      // nothing more to do without risking a throw
    }
  }
}

function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}
