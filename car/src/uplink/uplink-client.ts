/**
 * The head unit's side of the car link (`/car/v1`, packages/shared/src/car-dto.ts). It owns no timer:
 * it acts only from onTick() and from explicit calls, so a sleeping power gate means a silent uplink.
 * Everything it keeps is bounded (240 snapshots, 20 alerts) and nothing is retried inside a request:
 * a failed batch goes back to the front of its buffer and waits for the next interval.
 *
 * A 401/403 (and a 4xx to a background send) blocks the device's bearer. The block ends when the device
 * changes or when the wiring calls retry(): the car makes up its own id and secret before the owner has
 * registered them on the pairing page, so its first requests are refused, and registering changes
 * nothing the client could see.
 */
import type { Clock, VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import {
  CAR_API_PREFIX,
  MAX_SNAPSHOTS_PER_BATCH,
  type AskStyle,
  type CarAlertBatch,
  type CarAskRequest,
  type CarConfigResponse,
  type CarSnapshotBatch,
  type DialogTurn,
} from '@copilot/shared';
import type { PowerState } from '../power/power-gate';
import type { Log } from '../safe';
import { UplinkError, type HttpsClient, type RequestOptions, type UplinkErrorKind } from './https-client';
import { RingBuffer } from './ring-buffer';

export type LinkStatus = 'unpaired' | 'offline' | 'clock' | 'error' | 'ok';

export const SNAPSHOT_BUFFER_SIZE = 240;
export const ALERT_QUEUE_MAX = 20;
export const SEND_INTERVAL_MS = 60_000;
/** GET /car/v1/dialog waits up to 25 s on the server, so its request may take longer than the default 15 s. */
export const DIALOG_POLL_TIMEOUT_MS = 35_000;
/** POST /car/v1/ask is one non-streamed reply; the backend may spend up to CLAUDE_TIMEOUT_MS = 60000 on it (plan 1, backend env). */
export const ASK_TIMEOUT_MS = 70_000;

export interface UplinkClientOptions {
  http: HttpsClient;
  device: () => { id: string; secret: string } | null;
  clock: Clock;
  log: Log;
  sendIntervalMs?: number;       // default 60_000
}

type Outcome = UplinkErrorKind | 'ok';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class UplinkClient {
  private readonly http: HttpsClient;
  private readonly device: () => { id: string; secret: string } | null;
  private readonly clock: Clock;
  private readonly log: Log;
  private readonly sendIntervalMs: number;
  private readonly snapshots = new RingBuffer<VehicleSnapshot>(SNAPSHOT_BUFFER_SIZE);
  private readonly alerts = new RingBuffer<AlertEvent>(ALERT_QUEUE_MAX);
  private lastBatchAt: number | null = null;
  private lastAlertAttemptAt: number | null = null;
  private batchInFlight = false;
  private alertsInFlight = false;
  /** Set by 401/403 or another 4xx: nothing is sent with this bearer until the device changes or retry(). */
  private blocked: { kind: 'unauthorized' | 'client-error'; bearer: string } | null = null;
  private lastOutcome: Outcome | null = null;
  /** Between close() and reopen(): nothing is sent and every explicit request is refused as offline. */
  private closed = false;

  constructor(o: UplinkClientOptions) {
    this.http = o.http;
    this.device = o.device;
    this.clock = o.clock;
    this.log = o.log;
    this.sendIntervalMs = typeof o.sendIntervalMs === 'number' && o.sendIntervalMs > 0 ? o.sendIntervalMs : SEND_INTERVAL_MS;
  }

  /** Keeps a copy of the snapshot (the provider updates its own object in place) for the next batch. */
  recordSnapshot(snapshot: VehicleSnapshot): void {
    try {
      this.snapshots.push(JSON.parse(JSON.stringify(snapshot)) as VehicleSnapshot);
    } catch {
      // not serialisable: it could not be sent either
    }
  }

  /**
   * Driving, the interval elapsed and online: one batch of at most 60 snapshots. Not asleep: alerts kept
   * from an earlier failure are sent again, at most once per interval. Otherwise nothing.
   */
  onTick(power: PowerState): void {
    try {
      if (power === 'asleep' || this.closed) return;
      const bearer = this.bearer();
      if (bearer === null || !this.http.online()) return;
      const now = this.clock.now();
      if (power === 'driving' && !this.batchInFlight && this.snapshots.size() > 0 && this.elapsed(this.lastBatchAt, now)) {
        this.sendBatch(bearer, now);
      }
      if (!this.alertsInFlight && this.alerts.size() > 0 && this.elapsed(this.lastAlertAttemptAt, now)) {
        this.flushAlerts(bearer, now);
      }
    } catch (error) {
      this.note(error);
    }
  }

  /** Sends at once when online; otherwise keeps them (the newest 20) for the next successful send. */
  sendAlerts(events: AlertEvent[]): void {
    try {
      for (const event of events) this.alerts.push(event);
      if (this.alerts.size() === 0 || this.alertsInFlight || this.closed) return;
      const bearer = this.bearer();
      if (bearer === null || !this.http.online()) return;
      this.flushAlerts(bearer, this.clock.now());
    } catch (error) {
      this.note(error);
    }
  }

  ask(text: string, style: AskStyle): Promise<DialogTurn> {
    const body: CarAskRequest = { text, style };
    return this.call<DialogTurn>('POST', CAR_API_PREFIX + '/ask', body, { timeoutMs: ASK_TIMEOUT_MS }, (reply) =>
      isObject(reply) && isObject(reply.turn) ? (reply.turn as unknown as DialogTurn) : null,
    );
  }

  fetchConfig(): Promise<CarConfigResponse> {
    return this.call<CarConfigResponse>('GET', CAR_API_PREFIX + '/config', null, undefined, (reply) =>
      isObject(reply) && isObject(reply.ownerLimits) && typeof reply.popupsEnabled === 'boolean' ? (reply as unknown as CarConfigResponse) : null,
    );
  }

  /** One GET /car/v1/dialog (the server waits up to 25 s for a newer turn); the caller decides when to call again. */
  pollDialog(afterTurnId: string | null): Promise<DialogTurn[]> {
    const query = afterTurnId === null ? '' : '?after=' + encodeURIComponent(afterTurnId);
    // on its own connection (HttpsClient), so a held poll does not delay alerts, snapshots or a question
    return this.call<DialogTurn[]>('GET', CAR_API_PREFIX + '/dialog' + query, null, { timeoutMs: DIALOG_POLL_TIMEOUT_MS, longPoll: true }, (reply) =>
      isObject(reply) && Array.isArray(reply.turns) ? (reply.turns as DialogTurn[]) : null,
    );
  }

  status(): LinkStatus {
    try {
      const device = this.device();
      if (!device) return 'unpaired';
      if (this.blocked !== null && this.blocked.bearer === device.id + '.' + device.secret) {
        return this.blocked.kind === 'unauthorized' ? 'unpaired' : 'error';
      }
      if (!this.http.online()) return 'offline';
    } catch {
      return 'error';
    }
    switch (this.lastOutcome) {
      case null:
      case 'ok':
        return 'ok';
      case 'offline':
      case 'dns':
        return 'offline';
      case 'clock':
        return 'clock';
      case 'unauthorized':
        return 'unpaired'; // lifted by retry(), not yet answered otherwise
      default:
        return 'error';
    }
  }

  /** What is waiting to be sent (both bounded: 240 snapshots, 20 alerts). */
  queued(): { snapshots: number; alerts: number } {
    return { snapshots: this.snapshots.size(), alerts: this.alerts.size() };
  }

  /**
   * Lifts an `unauthorized` block, and a `client-error` block left by a background send, so that the
   * next request is attempted with the same device. Sends nothing by itself and starts no timer: the
   * wiring calls it on waking from asleep and, while the pairing screen is visible, at most every 30 s.
   */
  retry(): void {
    this.blocked = null;
  }

  /** Closes the connection; nothing is sent until reopen() (what is waiting stays queued). */
  close(): void {
    this.closed = true;
    try {
      this.http.close();
    } catch (error) {
      this.note(error);
    }
  }

  /** Opens the client again after close(); the next request opens a new connection. */
  reopen(): void {
    this.closed = false;
    try {
      this.http.reopen();
    } catch (error) {
      this.note(error);
    }
  }

  private elapsed(last: number | null, now: number): boolean {
    return last === null || now < last || now - last >= this.sendIntervalMs; // a clock that went back does not stall
  }

  /** The bearer for the current device, or null when unpaired or blocked for this device. */
  private bearer(): string | null {
    const device = this.device();
    if (!device || typeof device.id !== 'string' || typeof device.secret !== 'string') return null;
    const bearer = device.id + '.' + device.secret;
    if (this.blocked !== null) {
      if (this.blocked.bearer === bearer) return null;
      this.blocked = null; // the device changed: try again
      this.lastOutcome = null;
    }
    return bearer;
  }

  private sendBatch(bearer: string, now: number): void {
    const batch = this.snapshots.drain(MAX_SNAPSHOTS_PER_BATCH);
    if (batch.length === 0) return;
    const body: CarSnapshotBatch = { snapshots: batch };
    this.batchInFlight = true;
    this.lastBatchAt = now;
    this.send(bearer, CAR_API_PREFIX + '/snapshots', body).then(
      () => {
        this.batchInFlight = false;
      },
      () => {
        this.batchInFlight = false;
        this.snapshots.pushFront(batch);
      },
    );
  }

  private flushAlerts(bearer: string, now: number): void {
    const batch = this.alerts.drain(ALERT_QUEUE_MAX);
    if (batch.length === 0) return;
    const body: CarAlertBatch = { alerts: batch };
    this.alertsInFlight = true;
    this.lastAlertAttemptAt = now;
    this.send(bearer, CAR_API_PREFIX + '/alerts', body).then(
      () => {
        this.alertsInFlight = false;
      },
      () => {
        this.alertsInFlight = false;
        this.alerts.pushFront(batch);
      },
    );
  }

  /** A POST with the given bearer whose outcome is recorded; always settles, rejecting with an UplinkError. */
  private send(bearer: string, path: string, body: unknown): Promise<unknown> {
    let pending: Promise<unknown>;
    try {
      pending = this.http.request<unknown>('POST', path, body, bearer);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (reply) => {
        this.lastOutcome = 'ok';
        return reply;
      },
      (error: unknown) => {
        throw this.failed(error, bearer, true);
      },
    );
  }

  /** An explicit request: refused at once when unpaired or blocked; the reply's shape is checked. */
  private call<T>(method: 'GET' | 'POST', path: string, body: unknown, options: RequestOptions | undefined, shape: (reply: unknown) => T | null): Promise<T> {
    if (this.closed) return Promise.reject(new UplinkError('offline', 'the uplink is closed'));
    let bearer: string | null;
    let paired = false;
    try {
      paired = !!this.device();
      bearer = this.bearer();
    } catch {
      bearer = null;
    }
    if (bearer === null) {
      if (!paired || this.blocked === null) return Promise.reject(new UplinkError('unauthorized', 'no paired device'));
      return Promise.reject(new UplinkError(this.blocked.kind, 'the backend refused this device'));
    }
    const used = bearer;
    let pending: Promise<unknown>;
    try {
      pending = this.http.request<unknown>(method, path, body, used, options);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (reply) => {
        const value = shape(reply);
        if (value === null) throw this.failed(new UplinkError('server-error', 'unexpected reply from ' + path.split('?')[0]), used, false);
        this.lastOutcome = 'ok';
        return value;
      },
      (error: unknown) => {
        throw this.failed(error, used, false);
      },
    );
  }

  /**
   * Records a failure and returns it as an UplinkError. `unauthorized` blocks this bearer; `client-error`
   * blocks it only when a background send (snapshots, alerts) got it: that is a lasting mismatch with
   * the backend, while a 4xx to a question (a validation or budget refusal) concerns that question only.
   */
  private failed(error: unknown, bearer: string, background: boolean): UplinkError {
    const uplinkError = error instanceof UplinkError ? error : new UplinkError('server-error', 'unexpected failure');
    this.lastOutcome = uplinkError.kind;
    const blocks = uplinkError.kind === 'unauthorized' || (background && uplinkError.kind === 'client-error');
    if (blocks && (this.blocked === null || this.blocked.bearer !== bearer)) {
      this.blocked = { kind: uplinkError.kind, bearer };
      this.note('the backend refused a request (' + uplinkError.kind + '); nothing more is sent until the device changes or retry()');
    }
    return uplinkError;
  }

  private note(problem: unknown): void {
    try {
      this.log.warn('uplink: ' + (problem instanceof Error ? problem.message : String(problem)));
    } catch {
      // logging is best effort
    }
  }
}
