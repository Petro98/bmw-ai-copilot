import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { AlertEvent } from '@copilot/event-engine';
import type { LiveEvent, StatusDto } from '@copilot/shared';
import type { VehicleSnapshot } from '@copilot/vehicle-core';
import { ApiService } from './api.service';

/** The part of `EventSource` this service uses (so tests can supply a fake). */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export const EVENT_SOURCE_FACTORY = new InjectionToken<(url: string) => EventSourceLike>('EVENT_SOURCE_FACTORY', {
  providedIn: 'root',
  factory: () => (url: string) => new EventSource(url),
});

export const MAX_ALERTS = 50;
const EVENTS_URL = '/api/events';
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** Live state from `GET /api/events`; reconnects with a delay growing from 1 s to 30 s. */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly api = inject(ApiService);
  private readonly createSource = inject(EVENT_SOURCE_FACTORY);

  private readonly snapshotState = signal<VehicleSnapshot | null>(null);
  private readonly alertsState = signal<AlertEvent[]>([]);
  private readonly statusState = signal<StatusDto | null>(null);
  private readonly connectedState = signal(false);
  private readonly alertsLoadedState = signal(false);

  readonly snapshot = this.snapshotState.asReadonly();
  /** Newest first, at most 50. */
  readonly alerts = this.alertsState.asReadonly();
  readonly status = this.statusState.asReadonly();
  readonly connected = this.connectedState.asReadonly();
  /**
   * True once the recent alert list has arrived over REST; an empty list before that means "not loaded", not
   * "no alerts". It stays true when the stream drops, since the list on screen is still what was loaded.
   */
  readonly alertsLoaded = this.alertsLoadedState.asReadonly();

  private source: EventSourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = FIRST_RETRY_MS;
  private wanted = false;
  /** True once the current connection has streamed a snapshot; the REST snapshot must not replace it. */
  private streamedSnapshot = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
  }

  connect(): void {
    this.wanted = true;
    if (this.source || this.retryTimer !== null) return;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeSource();
    this.retryMs = FIRST_RETRY_MS;
  }

  /**
   * Opens the stream again now, with the delay back at 1 s, instead of waiting for the pending retry (after the
   * owner signs in). Does nothing after `disconnect()`.
   */
  reconnectNow(): void {
    if (!this.wanted) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeSource();
    this.retryMs = FIRST_RETRY_MS;
    this.open();
  }

  private open(): void {
    const source = this.createSource(EVENTS_URL);
    this.source = source;
    this.streamedSnapshot = false;
    source.onopen = () => {
      if (this.source !== source) return;
      this.connectedState.set(true);
      this.retryMs = FIRST_RETRY_MS;
      this.loadInitialState(source);
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.closeSource();
      this.scheduleReconnect();
      // EventSource does not expose the HTTP status. The same request through HttpClient does: a 401 there passes
      // `unauthorizedInterceptor`, which opens «Вхід» like every other 401. Any other failure is ignored.
      this.api.status().subscribe({ error: () => undefined });
    };
    for (const type of ['snapshot', 'alert', 'status'] as const) {
      source.addEventListener(type, (message) => {
        if (this.source === source) this.handle(message.data);
      });
    }
  }

  private closeSource(): void {
    const source = this.source;
    this.source = null;
    this.connectedState.set(false);
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
    }
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.retryTimer !== null) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  /** The stream carries changes only, so the current status, snapshot and recent alerts come over REST. */
  private loadInitialState(source: EventSourceLike): void {
    this.api.status().subscribe({ next: (status) => this.statusState.set(status), error: () => undefined });
    this.api.snapshot().subscribe({
      // A snapshot streamed on this connection is at least as fresh as the REST reply (REST and stream can race).
      // Compared per connection, not by takenAt: the head-unit clock can step backwards.
      next: (snapshot) => {
        if (this.source === source && !this.streamedSnapshot) this.snapshotState.set(snapshot);
      },
      error: () => undefined,
    });
    this.api.alerts(MAX_ALERTS).subscribe({
      next: (alerts) => {
        this.mergeAlerts(alerts);
        this.alertsLoadedState.set(true);
      },
      error: () => undefined,
    });
  }

  private handle(data: unknown): void {
    let event: LiveEvent;
    try {
      event = JSON.parse(String(data)) as LiveEvent;
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'snapshot':
        if (event.snapshot && typeof event.snapshot === 'object') {
          this.streamedSnapshot = true;
          this.snapshotState.set(event.snapshot);
        }
        break;
      case 'alert':
        if (event.alert && typeof event.alert.id === 'string') this.mergeAlerts([event.alert]);
        break;
      case 'status':
        if (event.status && typeof event.status === 'object') this.statusState.set(event.status);
        break;
    }
  }

  /** Same id replaces the earlier copy (an alert that cleared); newest first; at most 50. */
  private mergeAlerts(incoming: AlertEvent[]): void {
    const byId = new Map<string, AlertEvent>();
    for (const alert of this.alertsState()) byId.set(alert.id, alert);
    for (const alert of incoming) byId.set(alert.id, alert);
    const merged = Array.from(byId.values()).sort((a, b) => b.at - a.at).slice(0, MAX_ALERTS);
    this.alertsState.set(merged);
  }
}
