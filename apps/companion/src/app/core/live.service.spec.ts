import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { AlertEvent } from '@copilot/event-engine';
import type { StatusDto } from '@copilot/shared';
import type { VehicleSnapshot } from '@copilot/vehicle-core';
import { ApiService } from './api.service';
import { EVENT_SOURCE_FACTORY, EventSourceLike, LiveService } from './live.service';

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void { this.closed = true; }

  open(): void { this.onopen?.(new Event('open')); }

  fail(): void { this.onerror?.(new Event('error')); }

  emit(type: string, payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  }
}

function snapshotAt(takenAt: number): VehicleSnapshot {
  // Only the fields this spec reads; the service treats the snapshot as opaque data.
  return { takenAt } as VehicleSnapshot;
}

function alert(id: string, at: number, active = true): AlertEvent {
  return {
    id, ruleId: 'check-control', dedupKey: `cc:${id}`, provenance: 'bmw-check-control', severity: 'warning',
    title: `Alert ${id}`, detail: null, at, active, clearedAt: active ? null : at + 1,
  };
}

const STATUS: StatusDto = {
  version: '0.1.0',
  vehicle: { source: 'mock', connected: true, lastSnapshotAt: 1, scenario: 'steady-cruise' },
  claude: { mode: 'mock', model: 'claude-opus-5-5', voiceModel: 'claude-opus-5-5' },
  budget: { dayUsd: 0, dayLimitUsd: 1, monthUsd: 0, monthLimitUsd: 20 },
};

describe('LiveService', () => {
  let sources: FakeEventSource[];
  let api: { status: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn>; alerts: ReturnType<typeof vi.fn> };

  function create(): LiveService {
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: EVENT_SOURCE_FACTORY, useValue: (url: string) => { const s = new FakeEventSource(url); sources.push(s); return s; } },
      ],
    });
    return TestBed.inject(LiveService);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    api = {
      status: vi.fn(() => of(STATUS)),
      snapshot: vi.fn(() => of(snapshotAt(5))),
      alerts: vi.fn(() => of([])),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('LiveService applies snapshot, alert and status events and caps alerts at 50', () => {
    const live = create();
    live.connect();
    expect(sources.length).toBe(1);
    expect(sources[0].url).toBe('/api/events');
    sources[0].open();
    expect(live.connected()).toBe(true);

    sources[0].emit('snapshot', { type: 'snapshot', snapshot: snapshotAt(100) });
    expect(live.snapshot()?.takenAt).toBe(100);

    sources[0].emit('status', { type: 'status', status: { ...STATUS, version: '9.9.9' } });
    expect(live.status()?.version).toBe('9.9.9');

    for (let i = 0; i < 60; i++) sources[0].emit('alert', { type: 'alert', alert: alert(`a${i}`, 1000 + i) });
    expect(live.alerts().length).toBe(50);
    expect(live.alerts()[0].id).toBe('a59');            // newest first
    expect(live.alerts()[49].id).toBe('a10');
  });

  it('replaces an alert that arrives again with the same id instead of adding it', () => {
    const live = create();
    live.connect();
    sources[0].open();
    sources[0].emit('alert', { type: 'alert', alert: alert('x', 10) });
    sources[0].emit('alert', { type: 'alert', alert: alert('x', 10, false) });
    expect(live.alerts()).toEqual([alert('x', 10, false)]);
  });

  it('loads status, snapshot and recent alerts over REST when the stream opens', () => {
    api.alerts.mockReturnValue(of([alert('old', 1)]));
    const live = create();
    live.connect();
    sources[0].open();
    expect(api.alerts).toHaveBeenCalledWith(50);
    expect(live.status()).toEqual(STATUS);
    expect(live.snapshot()?.takenAt).toBe(5);
    expect(live.alerts().map((a) => a.id)).toEqual(['old']);
  });

  it('keeps a newer streamed snapshot over an older REST one', () => {
    api.snapshot.mockReturnValue(of(snapshotAt(1)));
    const live = create();
    live.connect();
    sources[0].emit('snapshot', { type: 'snapshot', snapshot: snapshotAt(50) });
    sources[0].open();
    expect(live.snapshot()?.takenAt).toBe(50);
  });

  it('always applies a streamed snapshot, even when its takenAt steps backwards', () => {
    const live = create();
    live.connect();
    sources[0].open();
    sources[0].emit('snapshot', { type: 'snapshot', snapshot: snapshotAt(100) });
    sources[0].emit('snapshot', { type: 'snapshot', snapshot: snapshotAt(50) });
    expect(live.snapshot()?.takenAt).toBe(50);
  });

  it('applies the REST snapshot on a new connection even when an earlier connection streamed a later takenAt', () => {
    api.snapshot.mockReturnValue(of(snapshotAt(1)));
    const live = create();
    live.connect();
    sources[0].open();
    sources[0].emit('snapshot', { type: 'snapshot', snapshot: snapshotAt(100) });
    sources[0].fail();
    vi.advanceTimersByTime(1000);
    sources[1].open();
    expect(live.snapshot()?.takenAt).toBe(1);
  });

  it('ignores malformed event data without throwing', () => {
    const live = create();
    live.connect();
    sources[0].open();
    expect(() => sources[0].emit('snapshot', '{not json')).not.toThrow();
    expect(() => sources[0].emit('alert', { type: 'alert' })).not.toThrow();
    expect(live.alerts()).toEqual([]);
  });

  it('reconnects with a delay growing from 1 s to 30 s and resets it after a successful open', () => {
    const live = create();
    live.connect();
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of expected) {
      const current = sources[sources.length - 1];
      current.fail();
      expect(current.closed).toBe(true);
      expect(live.connected()).toBe(false);
      const before = sources.length;
      vi.advanceTimersByTime(delay - 1);
      expect(sources.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(sources.length).toBe(before + 1);
    }
    sources[sources.length - 1].open();
    sources[sources.length - 1].fail();
    const before = sources.length;
    vi.advanceTimersByTime(1000);
    expect(sources.length).toBe(before + 1);
  });

  it('disconnect closes the stream and stops reconnecting', () => {
    const live = create();
    live.connect();
    sources[0].open();
    sources[0].fail();
    live.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(sources.length).toBe(1);
    expect(sources[0].closed).toBe(true);
    expect(live.connected()).toBe(false);
  });

  it('asks for the status over HTTP when the stream fails, so a 401 there reaches the sign-in redirect', () => {
    const live = create();
    live.connect();
    expect(api.status).not.toHaveBeenCalled();
    sources[0].fail();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('says whether the alert list has loaded; it stays loaded when the stream drops', () => {
    const live = create();
    live.connect();
    expect(live.alertsLoaded()).toBe(false);
    sources[0].emit('alert', { type: 'alert', alert: alert('x', 10) });
    expect(live.alertsLoaded()).toBe(false);              // one streamed alert is not the recent list
    sources[0].open();
    expect(live.alertsLoaded()).toBe(true);
    sources[0].fail();
    expect(live.alertsLoaded()).toBe(true);
  });

  it('stays not loaded when the REST alert list fails', () => {
    api.alerts.mockReturnValue(throwError(() => new Error('down')));
    const live = create();
    live.connect();
    sources[0].open();
    expect(live.alertsLoaded()).toBe(false);
  });

  it('reconnectNow opens a new stream at once and resets the delay', () => {
    const live = create();
    live.connect();
    for (let i = 0; i < 5; i++) {
      sources[sources.length - 1].fail();
      vi.runOnlyPendingTimers();
    }
    sources[sources.length - 1].fail();                  // the next attempt would be 30 s away
    const before = sources.length;
    live.reconnectNow();
    expect(sources.length).toBe(before + 1);
    vi.advanceTimersByTime(60_000);
    expect(sources.length).toBe(before + 1);             // the pending retry was cancelled
    sources[sources.length - 1].fail();
    vi.advanceTimersByTime(1000);
    expect(sources.length).toBe(before + 2);             // and the delay starts again from 1 s
  });

  it('reconnectNow does nothing after disconnect', () => {
    const live = create();
    live.connect();
    live.disconnect();
    live.reconnectNow();
    expect(sources.length).toBe(1);
  });

  it('connect is idempotent while a stream is open', () => {
    const live = create();
    live.connect();
    live.connect();
    expect(sources.length).toBe(1);
  });
});
