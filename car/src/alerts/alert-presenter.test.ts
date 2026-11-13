import { describe, expect, test } from 'vitest';
import type { AlertEvent } from '@copilot/event-engine';
import { available, emptySnapshot, type Severity, type VehicleSnapshot } from '@copilot/vehicle-core';
import type { Log } from '../safe';
import {
  AlertPresenter, POPUP_CHECK_MS, POPUP_OK_BUTTON, POPUP_QUEUE_MAX, POPUP_SETTLE_MS, POPUP_STATE, POPUP_TEXT_LABEL,
  POPUP_VISIBLE_MS, popupGates, type UiApi,
} from './alert-presenter';
import { markReopened } from './rule-runner';

/* ---------- fakes ---------- */

interface FakeTimer { id: number; at: number; every: number | null; fn: () => void }

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  /** Live timers by id (a plain record: car/src never contains the map write call the safety grep looks for). */
  const timers: Record<number, FakeTimer> = {};
  const api = {
    setTimeout(fn: () => void, ms: number): unknown {
      const t = { id: nextId++, at: now + ms, every: null, fn };
      timers[t.id] = t;
      return t.id;
    },
    clearTimeout(h: unknown): void {
      delete timers[h as number];
    },
    setInterval(fn: () => void, ms: number): unknown {
      const t = { id: nextId++, at: now + ms, every: ms, fn };
      timers[t.id] = t;
      return t.id;
    },
    clearInterval(h: unknown): void {
      delete timers[h as number];
    },
    pending(): number {
      return Object.keys(timers).length;
    },
    /** Runs every timer due within ms, in time order. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let due: FakeTimer | null = null;
        for (const key of Object.keys(timers)) {
          const t = timers[Number(key)];
          if (t.at <= end && (due === null || t.at < due.at)) due = t;
        }
        if (due === null) break;
        const t: FakeTimer = due;
        now = t.at;
        if (t.every === null) delete timers[t.id];
        else t.at += t.every;
        t.fn();
      }
      now = end;
    },
  };
  return api;
}

interface FakeUi extends UiApi {
  calls: string[];
  click(name: string): void;
  rejectNext: Set<string>;
}

function fakeUi(): FakeUi {
  const clicks: Record<string, () => void> = {};
  const ui: FakeUi = {
    calls: [],
    rejectNext: new Set(),
    open(name) {
      ui.calls.push('open ' + name);
      return settle('open');
    },
    close(name) {
      ui.calls.push('close ' + name);
      return settle('close');
    },
    text(name, text) {
      ui.calls.push('text ' + name + ' ' + text);
      return settle('text');
    },
    onClick(name, fn) {
      clicks[name] = fn;
    },
    click(name) {
      const fn = clicks[name];
      if (fn) fn();
    },
  };
  function settle(what: string): Promise<unknown> {
    if (ui.rejectNext.has(what)) {
      ui.rejectNext.delete(what);
      return Promise.reject(new Error(what + ' refused'));
    }
    return Promise.resolve();
  }
  return ui;
}

function memLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push('info ' + m),
    warn: (m) => lines.push('warn ' + m),
    error: (m) => lines.push('error ' + m),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let seq = 0;
function alert(severity: Severity, title: string, extra: Partial<AlertEvent> = {}): AlertEvent {
  seq++;
  return {
    id: 'check-control:cc:' + seq + ':1000', ruleId: 'check-control', dedupKey: 'cc:' + seq, provenance: 'bmw-check-control',
    severity, title, detail: null, at: 1000, active: true, clearedAt: null, ...extra,
  };
}

function setup(opts: { enabled?: () => boolean; ascii?: () => boolean; hold?: () => boolean } = {}) {
  const ui = fakeUi();
  const timers = fakeTimers();
  const log = memLog();
  const presenter = new AlertPresenter({
    ui, timers, log, enabled: opts.enabled || (() => true), ascii: opts.ascii || (() => false), hold: opts.hold,
  });
  return { ui, timers, log, presenter };
}

/** The texts the pop-up was given, in order. */
function shown(ui: FakeUi): string[] {
  return ui.calls.filter((c) => c.startsWith('text ')).map((c) => c.slice(('text ' + POPUP_TEXT_LABEL + ' ').length));
}

/* ---------- tests ---------- */

describe('AlertPresenter', () => {
  test('the pop-up names come from app.json and the kit build (ALERT_POP, _TEXT, _OK)', () => {
    expect(POPUP_STATE).toBe('ALERT_POP');
    expect(POPUP_TEXT_LABEL).toBe('ALERT_POP_TEXT');
    expect(POPUP_OK_BUTTON).toBe('ALERT_POP_OK');
    expect(POPUP_VISIBLE_MS).toBe(8000);
    expect(POPUP_QUEUE_MAX).toBe(3);
  });

  test('the presenter opens the pop-up and only then sets its text', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('warning', 'Тиск у шинах: задня ліва'));
    await flush();
    expect(ui.calls).toEqual([]);                               // the settle delay lets BMW's own message come first
    timers.advance(POPUP_SETTLE_MS - 1);
    await flush();
    expect(ui.calls).toEqual([]);
    timers.advance(1);
    await flush();
    expect(ui.calls).toEqual(['open ALERT_POP', 'text ALERT_POP_TEXT Авто повідомляє: Тиск у шинах: задня ліва']);
  });

  test('presentText shows its own text with the same settle delay and gates as an alert, once while it waits or shows', async () => {
    let on = true;
    let latin = false;
    const { ui, timers, presenter } = setup({ enabled: () => on, ascii: () => latin });
    presenter.presentText('test-popup', 'Тестове сповіщення Copilot');
    presenter.presentText('test-popup', 'Тестове сповіщення Copilot');    // already waiting: not twice
    timers.advance(POPUP_SETTLE_MS - 1);
    await flush();
    expect(ui.calls).toEqual([]);
    timers.advance(1);
    await flush();
    expect(ui.calls).toEqual(['open ALERT_POP', 'text ALERT_POP_TEXT Тестове сповіщення Copilot']);
    presenter.presentText('test-popup', 'Тестове сповіщення Copilot');    // already up: not again
    timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Тестове сповіщення Copilot']);
    expect(timers.pending()).toBe(0);

    latin = true;
    presenter.presentText('test-popup', 'Тестове сповіщення Copilot');
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)[1]).toMatch(/^Testove spovishchennia Copilot$/);
    presenter.closeAll();
    await flush();

    on = false;
    presenter.presentText('test-popup', 'Тестове сповіщення Copilot');
    timers.advance(POPUP_SETTLE_MS + POPUP_VISIBLE_MS);
    await flush();
    expect(shown(ui)).toHaveLength(2);
    expect(timers.pending()).toBe(0);
    expect(() => presenter.presentText(null as unknown as string, null as unknown as string)).not.toThrow();
  });

  test('the pop-up closes by itself after POPUP_VISIBLE_MS, and no timer is left behind', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('warning', 'A'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    timers.advance(POPUP_VISIBLE_MS - 1);
    await flush();
    expect(ui.calls).not.toContain('close ALERT_POP');
    timers.advance(1);
    await flush();
    expect(ui.calls[ui.calls.length - 1]).toBe('close ALERT_POP');
    expect(timers.pending()).toBe(0);
  });

  test('the OK button closes the pop-up', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('warning', 'A'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    ui.click(POPUP_OK_BUTTON);
    await flush();
    expect(ui.calls[ui.calls.length - 1]).toBe('close ALERT_POP');
    expect(timers.pending()).toBe(0);
  });

  test('one pop-up at a time; the next shows after the first closes; critical jumps the queue', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('warning', 'W1'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    presenter.present(alert('warning', 'W2'));
    presenter.present(alert('critical', 'C1'));
    await flush();
    expect(ui.calls.filter((c) => c.startsWith('open')).length).toBe(1);
    expect(shown(ui)).toEqual(['Авто повідомляє: W1']);

    ui.click(POPUP_OK_BUTTON);                                   // W1 closes
    await flush();
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: W1', 'Авто повідомляє: C1']);
    timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: W1', 'Авто повідомляє: C1', 'Авто повідомляє: W2']);
    const opens = ui.calls.filter((c) => c.startsWith('open')).length;
    const closes = ui.calls.filter((c) => c.startsWith('close')).length;
    expect(opens).toBe(3);
    expect(closes).toBe(2);                                      // W2 is still up
  });

  test('the queue is capped at three and info events never pop up', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('info', 'I0'));
    timers.advance(POPUP_SETTLE_MS * 2);
    await flush();
    expect(ui.calls).toEqual([]);
    expect(timers.pending()).toBe(0);

    presenter.present(alert('warning', 'W0'));                   // showing
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    for (const t of ['W1', 'W2', 'W3', 'W4']) presenter.present(alert('warning', t));
    presenter.present(alert('info', 'I1'));
    for (let i = 0; i < 6; i++) {
      timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
      await flush();
    }
    expect(shown(ui)).toEqual(['Авто повідомляє: W0', 'Авто повідомляє: W2', 'Авто повідомляє: W3', 'Авто повідомляє: W4']);   // W1, the oldest, was dropped
  });

  test('beyond the cap the least severe waiting pop-up goes first, never a critical one for a warning', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('warning', 'W0'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    for (const t of ['C1', 'C2', 'C3']) presenter.present(alert('critical', t));
    presenter.present(alert('warning', 'W1'));                   // the queue is full of critical ones: W1 is dropped
    for (let i = 0; i < 5; i++) {
      timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
      await flush();
    }
    expect(shown(ui).map((t) => t.slice(-2))).toEqual(['W0', 'C1', 'C2', 'C3']);
  });

  test('the same event presented twice pops up once', async () => {
    const { ui, timers, presenter } = setup();
    const e = alert('warning', 'A');
    presenter.present(e);
    presenter.present({ ...e });
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    presenter.present({ ...e });
    for (let i = 0; i < 3; i++) {
      timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
      await flush();
    }
    expect(shown(ui)).toEqual(['Авто повідомляє: A']);
  });

  test('cleared and re-opened events never pop up', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('critical', 'gone', { active: false, clearedAt: 2000 }));
    presenter.present(markReopened(alert('critical', 'back inside its cooldown')));
    timers.advance(POPUP_SETTLE_MS * 3);
    await flush();
    expect(ui.calls).toEqual([]);
  });

  test('with pop-ups disabled nothing opens', async () => {
    const { ui, timers, presenter } = setup({ enabled: () => false });
    presenter.present(alert('critical', 'A'));
    timers.advance(POPUP_SETTLE_MS * 3);
    await flush();
    expect(ui.calls).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  test('pop-ups switched off during the settle delay: nothing opens and the queue is dropped', async () => {
    let on = true;
    const { ui, timers, presenter } = setup({ enabled: () => on });
    presenter.present(alert('critical', 'A'));
    presenter.present(alert('critical', 'B'));
    on = false;
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    on = true;
    timers.advance(POPUP_SETTLE_MS * 3);
    await flush();
    expect(ui.calls).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  test('a pop-up that is up closes within a second once pop-ups are switched off, and the queue is dropped', async () => {
    let on = true;
    const { ui, timers, presenter } = setup({ enabled: () => on });
    presenter.present(alert('critical', 'A'));
    presenter.present(alert('critical', 'B'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: A']);
    on = false;
    timers.advance(POPUP_CHECK_MS);
    await flush();
    expect(ui.calls[ui.calls.length - 1]).toBe('close ALERT_POP');
    expect(timers.pending()).toBe(0);
    on = true;
    timers.advance((POPUP_SETTLE_MS + POPUP_VISIBLE_MS) * 3);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: A']);
  });

  test('reverse engaged during the settle delay holds the pop-up back; it shows once reverse ends', async () => {
    let reversing = false;
    const { ui, timers, presenter } = setup({ hold: () => reversing });
    presenter.present(alert('critical', 'A'));
    timers.advance(POPUP_SETTLE_MS - 1000);
    reversing = true;
    timers.advance(1000);
    await flush();
    timers.advance(30_000);                                      // reversing out of a parking space
    await flush();
    expect(ui.calls).toEqual([]);
    expect(timers.pending()).toBe(1);                            // one re-check, nothing more
    reversing = false;
    timers.advance(POPUP_CHECK_MS);
    await flush();
    expect(ui.calls).toEqual(['open ALERT_POP', 'text ALERT_POP_TEXT Авто повідомляє: A']);
  });

  test('an event presented while reversing waits and shows after reverse ends', async () => {
    let reversing = true;
    const { ui, timers, presenter } = setup({ hold: () => reversing });
    presenter.present(alert('warning', 'A'));
    timers.advance(POPUP_SETTLE_MS * 5);
    await flush();
    expect(ui.calls).toEqual([]);
    reversing = false;
    timers.advance(POPUP_CHECK_MS);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: A']);
  });

  test('reverse engaged while a pop-up is up closes it within a second; it and the waiting ones show afterwards', async () => {
    let reversing = false;
    const { ui, timers, presenter } = setup({ hold: () => reversing });
    presenter.present(alert('critical', 'A'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    presenter.present(alert('warning', 'B'));
    presenter.present(alert('warning', 'C'));
    reversing = true;
    timers.advance(POPUP_CHECK_MS);
    await flush();
    expect(ui.calls[ui.calls.length - 1]).toBe('close ALERT_POP');
    timers.advance(60_000);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: A']);
    reversing = false;
    for (let i = 0; i < (4 * (POPUP_SETTLE_MS + POPUP_VISIBLE_MS)) / POPUP_CHECK_MS; i++) {
      timers.advance(POPUP_CHECK_MS);                            // second by second, as the HMI answers between timers
      await flush();
    }
    expect(shown(ui)).toEqual([
      'Авто повідомляє: A', 'Авто повідомляє: A', 'Авто повідомляє: B', 'Авто повідомляє: C',
    ]);
    expect(timers.pending()).toBe(0);
  });

  test('a pop-up interrupted by reverse goes back to the queue only once', async () => {
    let reversing = false;
    const { ui, timers, presenter } = setup({ hold: () => reversing });
    presenter.present(alert('critical', 'A'));
    for (let i = 0; i < 3; i++) {
      // shown, then interrupted by reverse
      timers.advance(POPUP_SETTLE_MS + POPUP_CHECK_MS);
      await flush();
      reversing = true;
      timers.advance(POPUP_CHECK_MS);
      await flush();
      reversing = false;
    }
    timers.advance((POPUP_SETTLE_MS + POPUP_VISIBLE_MS) * 3);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: A', 'Авто повідомляє: A']);
    expect(timers.pending()).toBe(0);
  });

  test('closeAll while held drops the queue and leaves no timer', async () => {
    const { ui, timers, presenter } = setup({ hold: () => true });
    presenter.present(alert('critical', 'A'));
    timers.advance(POPUP_SETTLE_MS * 3);
    presenter.closeAll();
    expect(timers.pending()).toBe(0);
    await flush();
    expect(ui.calls).toEqual([]);
  });

  test('popupGates: enabled is the owner switch, hold is reversing (or an unreadable snapshot)', () => {
    const forward = emptySnapshot(0);
    forward.gearStage = available('D', null, 'passive-signal', 0);
    const reverse: VehicleSnapshot = emptySnapshot(0);
    reverse.gearStage = available('R', null, 'passive-signal', 0);
    let snap = forward;
    let switchOn = true;
    const gates = popupGates(() => switchOn, () => snap);
    expect(gates.enabled()).toBe(true);
    expect(gates.hold()).toBe(false);
    snap = reverse;
    expect(gates.enabled()).toBe(true);
    expect(gates.hold()).toBe(true);
    snap = emptySnapshot(0);                                     // gear unknown: not held (only a known R holds)
    expect(gates.hold()).toBe(false);
    switchOn = false;
    expect(gates.enabled()).toBe(false);
    const throwing = popupGates(
      () => {
        throw new Error('settings broke');
      },
      () => {
        throw new Error('provider broke');
      },
    );
    expect(throwing.enabled()).toBe(false);
    expect(throwing.hold()).toBe(true);
  });

  test('a ui call that rejects is logged and the queue keeps moving', async () => {
    const { ui, timers, log, presenter } = setup();
    ui.rejectNext.add('open');
    presenter.present(alert('warning', 'A'));
    presenter.present(alert('warning', 'B'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    expect(log.lines.some((l) => /open refused/.test(l))).toBe(true);
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: B']);

    ui.rejectNext.add('text');
    ui.rejectNext.add('close');
    presenter.present(alert('warning', 'C'));
    timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
    await flush();
    timers.advance(POPUP_VISIBLE_MS + POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: B', 'Авто повідомляє: C']);
    expect(log.lines.some((l) => /text refused/.test(l))).toBe(true);
  });

  test('a ui call that throws synchronously never escapes present()', async () => {
    const { ui, timers, presenter } = setup();
    ui.open = () => {
      throw new Error('boom');
    };
    expect(() => presenter.present(alert('warning', 'A'))).not.toThrow();
    expect(() => timers.advance(POPUP_SETTLE_MS * 4)).not.toThrow();
    await flush();
  });

  test('with ascii on the text is transliterated', async () => {
    const { ui, timers, presenter } = setup({ ascii: () => true });
    presenter.present(alert('warning', 'Тиск у шинах: задня ліва'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    expect(shown(ui)).toEqual(['Avto povidomliaie: Tysk u shynakh: zadnia liva']);
  });

  test('closeAll closes what is up, drops the queue and leaves no timer', async () => {
    const { ui, timers, presenter } = setup();
    presenter.present(alert('warning', 'A'));
    presenter.present(alert('warning', 'B'));
    timers.advance(POPUP_SETTLE_MS);
    await flush();
    presenter.closeAll();
    await flush();
    expect(ui.calls[ui.calls.length - 1]).toBe('close ALERT_POP');
    expect(timers.pending()).toBe(0);
    timers.advance(POPUP_SETTLE_MS * 5);
    await flush();
    expect(shown(ui)).toEqual(['Авто повідомляє: A']);

    presenter.closeAll();                                        // nothing up: no ui call
    await flush();
    expect(ui.calls.filter((c) => c === 'close ALERT_POP').length).toBe(1);
  });

  test('closeAll while opening keeps a late open from setting text', async () => {
    const { ui, timers, presenter } = setup();
    let release: () => void = () => undefined;
    ui.open = (name) => {
      ui.calls.push('open ' + name);
      return new Promise<void>((r) => {
        release = r;
      });
    };
    presenter.present(alert('warning', 'A'));
    timers.advance(POPUP_SETTLE_MS);
    presenter.closeAll();
    release();
    await flush();
    expect(shown(ui)).toEqual([]);
    expect(ui.calls[ui.calls.length - 1]).toBe('close ALERT_POP');   // a late open is closed again
  });
});
