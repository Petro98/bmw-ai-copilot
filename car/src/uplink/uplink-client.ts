/**
 * The head unit's side of the car link (`/car/v1`, packages/shared/src/car-dto.ts). It owns no timer:
 * it acts only from onTick() and from explicit calls, so a sleeping power gate means a silent uplink.
 * Everything it keeps is bounded (240 snapshots, 20 alerts) and nothing is retried inside a request:
 * a failed batch goes back to the front of its buffer and waits for the next interval.
 *
 * Alerts take two ways into the one queue: sendAlerts() (a raise) sends at once; queueAlerts() (a clearing, a
 * re-opening) only queues. What is queued goes with the next raise, or from onTick(): while driving in the
 * same tick as the minute's snapshot batch (so it adds no wake-up of the link of its own), otherwise at most
 * once per interval. A raise that could not go out at once (offline, a send in flight, a failed send) is not
 * held for the batch: onTick() sends it as before, on the first online tick at most once per interval.
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
/**
 * The most a snapshot batch's request body may weigh (UTF-8 bytes of the JSON sent). The backend refuses a
 * car body over 512 kB (CAR_BODY_LIMIT_BYTES = 512 * 1024, apps/backend/src/features/car-link/routes.ts) with
 * a 400, which blocks background sends; 60 snapshots near the decoder's maxima (~32 kB each) are far larger.
 */
export const SNAPSHOT_BATCH_MAX_BYTES = 384_000;
/** The same for an alert batch. */
export const ALERT_BATCH_MAX_BYTES = 64_000;

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
  /** A raise (sendAlerts) waits in the alert queue: it is not held for the snapshot batch while driving. */
  private raiseWaiting = false;
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
   * Driving, the interval elapsed and online: one batch of at most 60 snapshots and SNAPSHOT_BATCH_MAX_BYTES. Not asleep: alerts kept
   * from an earlier failure are sent again, at most once per interval. Otherwise nothing.
   */
  onTick(power: PowerState): void {
    try {
      if (power === 'asleep' || this.closed) return;
      const bearer = this.bearer();
      if (bearer === null || !this.http.online()) return;
      const now = this.clock.now();
      const driving = power === 'driving';
      let batchSent = false;
      if (driving && !this.batchInFlight && this.snapshots.size() > 0 && this.elapsed(this.lastBatchAt, now)) {
        batchSent = this.sendBatch(bearer, now);
      }
      if (this.alertsInFlight || this.alerts.size() === 0) return;
      // a waiting raise, or not driving: at most once per interval; driving, clearings alone go with the minute's
      // batch, or by themselves only when no batch went out for a whole interval
      const due =
        batchSent ||
        (this.elapsed(this.lastAlertAttemptAt, now) && (this.raiseWaiting || !driving || this.elapsed(this.lastBatchAt, now)));
      if (due) this.flushAlerts(bearer, now);
    } catch (error) {
      this.note(error);
    }
  }

  /**
   * Keeps them (in the same queue, the newest 20) for the next send, without sending now: for a clearing or a
   * re-opening, which goes with the next raise or the next batch (see onTick). Never throws.
   */
  queueAlerts(events: AlertEvent[]): void {
    try {
      for (const event of events) this.alerts.push(event);
    } catch (error) {
      this.note(error);
    }
  }

  /** Sends at once when online, with whatever was queued before; otherwise keeps them (the newest 20) for the next send. */
  sendAlerts(events: AlertEvent[]): void {
    try {
      for (const event of events) this.alerts.push(event);
      if (events.length > 0) this.raiseWaiting = true;
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

  /**
   * One GET /car/v1/dialog (the server waits up to 25 s for a newer turn); the caller decides when to call again.
   * `cancelHandle`, when given, is called at once with a function that ends this poll alone: the promise then
   * rejects as `offline` and the link status is left as it was (a cancel is no failure of the link).
   */
  pollDialog(afterTurnId: string | null, cancelHandle?: (cancel: () => void) => void): Promise<DialogTurn[]> {
    const query = afterTurnId === null ? '' : '?after=' + encodeURIComponent(afterTurnId);
    let cancelled = false;
    let cancelRequest: (() => void) | null = null;
    const options: RequestOptions = { timeoutMs: DIALOG_POLL_TIMEOUT_MS, longPoll: true };
    if (typeof cancelHandle === 'function') options.cancelHandle = (fn) => (cancelRequest = fn);
    // on its own connection (HttpsClient), so a held poll does not delay alerts, snapshots or a question
    const pending = this.call<DialogTurn[]>('GET', CAR_API_PREFIX + '/dialog' + query, null, options, (reply) =>
      isObject(reply) && Array.isArray(reply.turns) ? (reply.turns as DialogTurn[]) : null,
      () => cancelled,
    );
    if (typeof cancelHandle === 'function') {
      try {
        cancelHandle(() => {
          if (cancelled) return;
          cancelled = true;
          const cancel = cancelRequest;
          if (cancel !== null) cancel();
        });
      } catch (error) {
        this.note(error);
      }
    }
    return pending;
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

  /**
   * Takes items oldest first while the request body `{"<key>":[...]}` stays within `maxBytes` and the batch
   * within `maxCount`; the rest stay in the buffer for the next send. Each item is measured once and the body's
   * size is the sum of the items, the commas between them and the wrapper. An item that alone exceeds the
   * budget (or cannot be serialised) could never be delivered: it is dropped with one warning.
   */
  private takeBatch<T>(buffer: RingBuffer<T>, key: string, maxCount: number, maxBytes: number): T[] {
    const batch: T[] = [];
    const wrapper = Buffer.byteLength(JSON.stringify({ [key]: [] }), 'utf8');
    let bytes = wrapper;
    while (batch.length < maxCount && buffer.size() > 0) {
      const item = buffer.drain(1)[0];
      let size: number;
      try {
        const text = JSON.stringify(item);
        size = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 4; // undefined is sent as null
      } catch {
        size = Infinity;
      }
      if (wrapper + size > maxBytes) {
        this.note('dropped one ' + key + ' item that alone exceeds the ' + maxBytes + ' byte batch limit');
        continue;
      }
      const added = (batch.length > 0 ? 1 : 0) + size;
      if (bytes + added > maxBytes) {
        buffer.pushFront([item]); // goes first in the next batch
        break;
      }
      bytes += added;
      batch.push(item);
    }
    return batch;
  }

  /** Sends the next batch within the count and byte limits; false when nothing was left to send. */
  private sendBatch(bearer: string, now: number): boolean {
    const batch = this.takeBatch(this.snapshots, 'snapshots', MAX_SNAPSHOTS_PER_BATCH, SNAPSHOT_BATCH_MAX_BYTES);
    if (batch.length === 0) return false;
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
    return true;
  }

  private flushAlerts(bearer: string, now: number): void {
    const batch = this.takeBatch(this.alerts, 'alerts', ALERT_QUEUE_MAX, ALERT_BATCH_MAX_BYTES);
    if (batch.length === 0) return;
    const body: CarAlertBatch = { alerts: batch };
    // the queue goes oldest first, within the byte limit; a raise waiting in it is the newest, so it is
    // delivered once the queue is empty, and waits again if this send fails or leaves alerts behind
    const withRaise = this.raiseWaiting;
    this.raiseWaiting = this.alerts.size() > 0 && withRaise;
    this.alertsInFlight = true;
    this.lastAlertAttemptAt = now;
    this.send(bearer, CAR_API_PREFIX + '/alerts', body).then(
      () => {
        this.alertsInFlight = false;
      },
      () => {
        this.alertsInFlight = false;
        this.alerts.pushFront(batch);
        if (withRaise) this.raiseWaiting = true;
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
  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: RequestOptions | undefined,
    shape: (reply: unknown) => T | null,
    cancelled: () => boolean = () => false,
  ): Promise<T> {
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
        // ended by its caller: not an outcome of the link, so nothing is recorded or blocked
        if (cancelled()) throw new UplinkError('offline', 'the request was cancelled');
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
