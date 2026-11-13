import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { userMessageFor } from '@copilot/ai-core';
import type { AlertEvent, Provenance } from '@copilot/event-engine';
import {
  CAR_API_PREFIX, MAX_SNAPSHOTS_PER_BATCH,
  type CarConfigResponse, type CarDialogResponse, type DeviceDto, type DialogTurn,
} from '@copilot/shared';
import type {
  GearStage, ReadingSource, ServiceStatus, Severity, UnavailableReason, Unit, VehicleCondition, VehicleSnapshot,
} from '@copilot/vehicle-core';
import { AssistantError } from '../../assistant/assistant-service';
import type { RouteContext } from '../../http/app';
import { HTTP_STATUS, HttpError, MESSAGES } from '../../http/errors';
import { parseAskRequest } from '../../http/schemas';
import type { DialogStore } from '../../stores/dialog-store';
import { ACCESS_MESSAGES, unauthorized } from '../access/routes';
import { clockOffset, shiftSnapshot, type CarLinkVehicleDataProvider } from './car-link-provider';
import { DEVICE_ID_PATTERN, MAX_SECRET_CHARS, MIN_SECRET_CHARS, type DeviceStore } from './device-store';

/** A long poll of GET /car/v1/dialog waits at most this long for a newer turn (packages/shared/src/car-dto.ts). */
export const DIALOG_WAIT_MS = 25_000;
/** Open long polls per device; a further one releases the oldest (a car whose earlier connection silently died). */
export const MAX_WAITERS_PER_DEVICE = 2;
/** Largest body of POST /car/v1/snapshots and /car/v1/alerts. */
export const CAR_BODY_LIMIT_BYTES = 512 * 1024;
/** The car keeps at most 20 alerts for one send (car/src/uplink/uplink-client.ts ALERT_QUEUE_MAX). */
export const MAX_ALERTS_PER_BATCH = 50;
/** Service items and fault codes per snapshot (the car keeps at most 32 service items: MAX_SERVICE_ITEMS in car/src/provider/raw-decoders.ts). */
export const MAX_LIST_ENTRIES = 50;
/**
 * Check Control messages per snapshot: the car keeps up to 64 active ones (MAX_CHECK_CONTROL in
 * car/src/provider/raw-decoders.ts). A lower bound here would refuse a snapshot the car may legitimately send, and a
 * 400 to a background send blocks the car's uplink (car/src/uplink/uplink-client.ts `failed`).
 */
export const MAX_CHECK_CONTROL_ENTRIES = 64;
/** Any text the car sends (a Check Control text, a title, a fault code text). */
export const MAX_CAR_TEXT_CHARS = 300;
/** Recent turns searched for the `after` id of a dialog poll. */
const DIALOG_LOOKBACK = 50;
const MAX_LABEL_CHARS = 60;

// Ukrainian, sentence case (docs/design/README.md → Content).
const CAR_MESSAGES = {
  badCarData: 'Некоректні дані від авто.',
  badDevice: 'Некоректні дані пристрою. Відскануйте QR-код на екрані авто ще раз.',
  badLabel: `Вкажіть назву пристрою: до ${MAX_LABEL_CHARS} символів.`,
  unknownDevice: 'Такого пристрою немає.',
  mockSource: 'Сервер працює з демо-авто. Дані й питання від авто він приймає лише з VEHICLE_SOURCE=car.',
} as const;

/** What the car link needs besides the app's own dependencies. */
export interface CarLinkDeps {
  devices: DeviceStore;
  /**
   * null unless VEHICLE_SOURCE=car. Without it the car's snapshots, alerts, questions and dialog polls are refused with
   * a 404 naming VEHICLE_SOURCE=car: a 4xx keeps the car's queue and darkens its network mark, so the car never shows
   * answers from the mock vehicle and its data is not silently lost.
   */
  provider: CarLinkVehicleDataProvider | null;
  /** The dialog store the assistant writes through, so a waiting poll hears of a new turn at once. */
  feed: DialogFeed;
  dialogWaitMs?: number;
}

/* ---------- the dialog: a store wrapper that announces every stored turn ---------- */

/**
 * The assistant's dialog store with a notification on every `add` (in-process, no polling). Long polls subscribe
 * with `onAdd` and are removed when they end, so the listener set is bounded by the open polls.
 * `historySince` is when the current vehicle source began (db/vehicle-source.ts): the assistant's history never
 * includes an older turn, so answers about the mock vehicle are not given to Claude as the real car's, or the reverse.
 */
export class DialogFeed implements Pick<DialogStore, 'add' | 'lastTurns'> {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: DialogStore, private readonly historySince: number = Number.MIN_SAFE_INTEGER) {}

  add(turn: DialogTurn): void {
    this.store.add(turn);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // A failing waiter must not fail the question that stored the turn.
      }
    }
  }

  /** The last `n` turns at or after both `historySince` and `since`, oldest first. */
  lastTurns(n: number, since?: number): DialogTurn[] {
    const from = typeof since === 'number' && Number.isFinite(since) ? Math.max(since, this.historySince) : this.historySince;
    return this.store.lastTurns(n, from);
  }

  /**
   * Turns strictly newer than `after`, oldest first. Without `after`, or with an id not among the recent turns,
   * at most the single latest turn.
   */
  newerThan(after: string | null): DialogTurn[] {
    const recent = this.store.recent(DIALOG_LOOKBACK);   // newest first
    if (recent.length === 0) return [];
    if (after !== null) {
      const index = recent.findIndex((turn) => turn.id === after);
      if (index >= 0) return recent.slice(0, index).reverse();
    }
    return [recent[0]];
  }

  onAdd(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

interface Waiter { deviceId: string; finish(turns: DialogTurn[]): void }

/** Open long polls. Every waiter ends by a new turn, its timer, its client leaving, a newer poll or shutdown. */
class DialogWaiters {
  private readonly waiters: Waiter[] = [];

  constructor(private readonly feed: DialogFeed, private readonly waitMs: number) {}

  wait(deviceId: string, after: string | null, reply: FastifyReply): Promise<DialogTurn[]> {
    return new Promise<DialogTurn[]>((resolve) => {
      let done = false;
      const finish = (turns: DialogTurn[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        reply.raw.off('close', onClose);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(turns);
      };
      const onClose = (): void => finish([]);
      const timer = setTimeout(() => finish([]), this.waitMs);
      const unsubscribe = this.feed.onAdd(() => {
        let turns: DialogTurn[];
        try {
          turns = this.feed.newerThan(after);
        } catch {
          turns = [];
        }
        if (turns.length > 0) finish(turns);
      });
      const waiter: Waiter = { deviceId, finish };
      reply.raw.once('close', onClose);
      this.waiters.push(waiter);
      const mine = this.waiters.filter((w) => w.deviceId === deviceId);
      if (mine.length > MAX_WAITERS_PER_DEVICE) mine[0].finish([]);
      // The client may have gone before the listener was attached.
      if (reply.raw.destroyed) finish([]);
    });
  }

  releaseDevice(deviceId: string): void {
    for (const waiter of this.waiters.filter((w) => w.deviceId === deviceId)) waiter.finish([]);
  }

  releaseAll(): void {
    for (const waiter of this.waiters.slice()) waiter.finish([]);
  }
}

/* ---------- validation of everything a device sends ---------- */

// The accepted values, as the types in packages/vehicle-core and packages/event-engine define them.
const UNITS = ['rpm', 'km/h', '°C', '°F', 'l', 'km', 'mi', '%', 'bar', 'psi', 'kPa', 'V'] as const satisfies readonly Unit[];
const SOURCES = ['passive-signal', 'polled-signal', 'diagnostic-read', 'mock'] as const satisfies readonly ReadingSource[];
const REASONS = ['not-reported', 'invalid-value', 'not-on-this-vehicle', 'diagnostics-disabled', 'stale'] as const satisfies readonly UnavailableReason[];
const CONDITIONS = ['parked', 'standby', 'living', 'ignition-on', 'starting', 'driving', 'stopping'] as const satisfies readonly VehicleCondition[];
const GEAR_STAGES = ['P', 'R', 'N', 'D'] as const satisfies readonly GearStage[];
const SEVERITIES = ['info', 'warning', 'critical'] as const satisfies readonly Severity[];
const SERVICE_STATUSES = ['ok', 'due-soon', 'overdue', 'unknown'] as const satisfies readonly ServiceStatus[];
const PROVENANCES = ['bmw-check-control', 'bmw-fault-status', 'bmw-service', 'owner-configured'] as const satisfies readonly Provenance[];

/** `true` only when a list names every member of its type: a type gaining a member fails to compile here. */
type Complete<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;
export const CAR_VALUE_LISTS_COMPLETE: [
  Complete<Unit, (typeof UNITS)[number]>, Complete<ReadingSource, (typeof SOURCES)[number]>,
  Complete<UnavailableReason, (typeof REASONS)[number]>, Complete<VehicleCondition, (typeof CONDITIONS)[number]>,
  Complete<GearStage, (typeof GEAR_STAGES)[number]>, Complete<Severity, (typeof SEVERITIES)[number]>,
  Complete<ServiceStatus, (typeof SERVICE_STATUSES)[number]>, Complete<Provenance, (typeof PROVENANCES)[number]>,
] = [true, true, true, true, true, true, true, true];

/**
 * A gear or drive mode is a short word ('D4', 'SPORT'). The car passes through an unknown drive-mode enum name of up
 * to 40 characters (applyDriveMode in car/src/provider/raw-decoders.ts: /^[A-Z][A-Z0-9_]{0,39}$/).
 */
const MAX_WORD_CHARS = 40;
const time = z.number();   // zod 4 rejects NaN and ±Infinity
const text = z.string().max(MAX_CAR_TEXT_CHARS);

function reading<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('available', [
    z.object({ available: z.literal(true), value, unit: z.enum(UNITS).nullable(), source: z.enum(SOURCES), at: time }),
    z.object({ available: z.literal(false), reason: z.enum(REASONS) }),
  ]);
}

const numberReading = reading(z.number());
const wordReading = reading(z.string().max(MAX_WORD_CHARS));
const tyres = z.object({ frontLeft: numberReading, frontRight: numberReading, rearLeft: numberReading, rearRight: numberReading });
const list = <T extends z.ZodType>(item: T, max = MAX_LIST_ENTRIES) => reading(z.array(item).max(max));

const snapshotSchema = z.object({
  takenAt: time,
  condition: reading(z.enum(CONDITIONS)),
  engineRpm: numberReading,
  speed: numberReading,
  oilTemp: numberReading,
  coolantTemp: numberReading,
  gear: wordReading,
  gearStage: reading(z.enum(GEAR_STAGES)),
  driveMode: wordReading,
  fuelLevel: numberReading,
  range: numberReading,
  odometer: numberReading,
  battery12vCharge: numberReading,
  battery12vVoltage: numberReading,
  intakeTemp: numberReading,
  boostPressure: numberReading,
  engineLoad: numberReading,
  tyrePressure: tyres,
  tyrePressureTarget: tyres,
  checkControl: list(z.object({ id: z.number(), text: text.nullable(), severity: z.enum(SEVERITIES), since: time }), MAX_CHECK_CONTROL_ENTRIES),
  serviceItems: list(z.object({ id: z.number(), name: text.nullable(), status: z.enum(SERVICE_STATUSES), dueText: text.nullable() })),
  faultCodes: list(z.object({ ecu: text, code: text, text: text.nullable(), activeNow: z.boolean(), warningLamp: z.boolean() })),
});

// `sentAt`: the car's clock at send time (packages/shared/src/car-dto.ts); optional, so an older car bundle still posts.
const snapshotBatchSchema = z.object({ snapshots: z.array(snapshotSchema).max(MAX_SNAPSHOTS_PER_BATCH), sentAt: time.optional() });

const alertSchema = z.object({
  id: z.string().min(1).max(1000),
  ruleId: z.string().min(1).max(64),
  dedupKey: z.string().min(1).max(800),
  provenance: z.enum(PROVENANCES),
  severity: z.enum(SEVERITIES),
  title: text,
  detail: text.nullable(),
  at: time,
  active: z.boolean(),
  clearedAt: time.nullable(),
}).refine(
  // A raise must be showable. Every car rule titles its raise with non-blank text (packages/event-engine/src/rules:
  // a missing car text falls back to a named title), so this never refuses what the car sends. Only a clearing may
  // be empty: one rebuilt after a restart (car/src/alerts/rule-runner.ts restoredClearing).
  (alert) => !alert.active || alert.title.trim() !== '',
);

const alertBatchSchema = z.object({ alerts: z.array(alertSchema).max(MAX_ALERTS_PER_BATCH), sentAt: time.optional() });

const dialogQuerySchema = z.object({ after: z.string().min(1).max(200).optional() });

const registrationSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  secret: z.string().min(MIN_SECRET_CHARS).max(MAX_SECRET_CHARS).regex(/^[\x21-\x7e]+$/),
  label: z.string().trim().min(1).max(MAX_LABEL_CHARS),
});

/**
 * Parsed snapshots, with their times moved onto the backend's clock when the batch's `sentAt` shows the head-unit
 * clock is off by more than CLOCK_TOLERANCE_MS (`receivedAt` is the backend's clock on arrival).
 * A malformed batch is one 400 and nothing of it is ingested.
 */
export function parseSnapshotBatch(body: unknown, receivedAt: number): VehicleSnapshot[] {
  const result = snapshotBatchSchema.safeParse(body);
  if (!result.success) throw new HttpError('validation', CAR_MESSAGES.badCarData);
  const snapshots: VehicleSnapshot[] = result.data.snapshots;
  const offset = clockOffset(result.data.sentAt, receivedAt);
  return offset === 0 ? snapshots : snapshots.map((snapshot) => shiftSnapshot(snapshot, offset));
}

/** Parsed alerts, `at` and `clearedAt` moved like the snapshots' times; the id (which holds the raise time) is kept. */
export function parseAlertBatch(body: unknown, receivedAt: number): AlertEvent[] {
  const result = alertBatchSchema.safeParse(body);
  if (!result.success) throw new HttpError('validation', CAR_MESSAGES.badCarData);
  const alerts: AlertEvent[] = result.data.alerts;
  const offset = clockOffset(result.data.sentAt, receivedAt);
  if (offset === 0) return alerts;
  return alerts.map((alert) => ({
    ...alert, at: alert.at + offset, clearedAt: alert.clearedAt === null ? null : alert.clearedAt + offset,
  }));
}

/* ---------- routes ---------- */

/** `Authorization: Bearer <deviceId>.<secret>` → the bearer token, or null. */
function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([\x21-\x7e]{1,400})$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * The owner's device management (`/api/devices`, behind the owner session hook) and the car link (`/car/v1/*`,
 * each request authenticated by its device token). Text from the car is stored and later framed as data by the
 * prompt builder, never as instructions. Nothing here writes to or controls a vehicle.
 */
export function carLinkRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const link = ctx.carLink;
  if (!link) return;
  const waiters = new DialogWaiters(link.feed, link.dialogWaitMs ?? DIALOG_WAIT_MS);
  const deviceOf = new WeakMap<FastifyRequest, string>();
  let offlineTimer: ReturnType<typeof setTimeout> | null = null;
  // Car questions still waiting for Claude; shutdown aborts them rather than wait up to CLAUDE_TIMEOUT_MS.
  const inFlight = new Set<AbortController>();

  app.addHook('preClose', async () => {
    waiters.releaseAll();
    for (const controller of Array.from(inFlight)) controller.abort();
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = null;
  });

  /* devices (owner) */

  app.get('/api/devices', async (): Promise<DeviceDto[]> => link.devices.list());

  app.post('/api/devices', async (request, reply): Promise<DeviceDto> => {
    const result = registrationSchema.safeParse(request.body);
    if (!result.success) {
      const label = result.error.issues.some((issue) => issue.path[0] === 'label');
      throw new HttpError('validation', label ? CAR_MESSAGES.badLabel : CAR_MESSAGES.badDevice);
    }
    const device = link.devices.register(result.data, ctx.clock.now());
    request.log.info({ deviceId: device.deviceId }, 'device paired');
    reply.code(201);
    return device;
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
    const id = request.params.id;
    if (!link.devices.remove(id)) throw new HttpError('not-found', CAR_MESSAGES.unknownDevice);
    waiters.releaseDevice(id);
    // Car mode: the alerts came from the car, and a clearing it never delivered cannot arrive any more. Not done on
    // re-registration (POST /api/devices), which also runs when the owner re-scans the QR of the same running car.
    const cleared = link.provider ? ctx.hub.clearActiveAlerts() : 0;
    request.log.info({ deviceId: id, alertsCleared: cleared }, 'device removed');
    return reply.code(204).send();
  });

  /* the car link */

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const bearer = bearerOf(request);
    const deviceId = bearer === null ? null : link.devices.verify(bearer);
    if (deviceId === null) {
      request.log.info('device request refused');
      return reply.code(HTTP_STATUS.unauthorized).send(unauthorized(ACCESS_MESSAGES.deviceRefused));
    }
    deviceOf.set(request, deviceId);
    try {
      link.devices.touch(deviceId, ctx.clock.now());
    } catch (error) {
      request.log.warn({ err: error }, 'device last-seen time not stored');
    }
    return undefined;
  };
  // Runs after `authenticate`: an unknown device still gets its 401 first.
  let warnedMockSource = false;
  const carSourceOnly = async (request: FastifyRequest): Promise<void> => {
    if (link.provider) return;
    if (!warnedMockSource) {
      warnedMockSource = true;
      request.log.warn('a paired car is calling but VEHICLE_SOURCE is not car: its data and questions are refused');
    }
    throw new HttpError('not-found', CAR_MESSAGES.mockSource);
  };
  const device = { onRequest: authenticate };
  const carData = { onRequest: [authenticate, carSourceOnly] };
  const carBody = { onRequest: [authenticate, carSourceOnly], bodyLimit: CAR_BODY_LIMIT_BYTES };

  app.post(`${CAR_API_PREFIX}/snapshots`, carBody, async (request, reply) => {
    const snapshots = parseSnapshotBatch(request.body, ctx.clock.now());
    const provider = link.provider;
    if (provider && snapshots.length > 0) {
      const wasConnected = provider.connected();
      provider.ingest(snapshots);
      if (!wasConnected) ctx.publishStatus();
      // One timer per backend, re-armed by each batch: the panel hears when the car has gone quiet.
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => {
        offlineTimer = null;
        ctx.publishStatus();
      }, provider.offlineAfterMs + 1000);
      offlineTimer.unref?.();
    }
    return reply.code(204).send();
  });

  app.post(`${CAR_API_PREFIX}/alerts`, carBody, async (request, reply) => {
    const alerts = parseAlertBatch(request.body, ctx.clock.now());
    for (const alert of alerts) ctx.hub.ingestAlert(alert);   // carSourceOnly: only with the car as vehicle source
    return reply.code(204).send();
  });

  app.post(`${CAR_API_PREFIX}/ask`, carData, async (request, reply): Promise<{ turn: DialogTurn }> => {
    const parsed = parseAskRequest(request.body);
    const ask = { text: parsed.text, style: parsed.style ?? 'full', source: 'car' as const };
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    // The car waits 70 s; the answer (or a refusal) leaves within CLAUDE_TIMEOUT_MS whatever the gateway does.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AssistantError('claude-unavailable', userMessageFor('timeout')));
      }, ctx.config.claudeTimeoutMs);
    });
    inFlight.add(controller);
    const answer = ctx.assistant.ask(ask, undefined, controller.signal);
    answer.catch(() => undefined);   // after a timeout its rejection has no reader
    try {
      const turn = await Promise.race([answer, timeout]);
      return { turn };
    } finally {
      inFlight.delete(controller);
      clearTimeout(timer);
      ctx.publishStatus();   // the spend may have changed
    }
  });

  app.get(`${CAR_API_PREFIX}/dialog`, carData, async (request, reply): Promise<CarDialogResponse> => {
    const query = dialogQuerySchema.safeParse(request.query ?? {});
    if (!query.success) throw new HttpError('validation', MESSAGES.invalidRequest);
    const after = query.data.after ?? null;
    const now = link.feed.newerThan(after);
    if (now.length > 0) return { turns: now };
    const deviceId = deviceOf.get(request) ?? '';
    return { turns: await waiters.wait(deviceId, after, reply) };
  });

  app.get(`${CAR_API_PREFIX}/config`, device, async (): Promise<CarConfigResponse> => {
    const settings = ctx.settings.get();
    return { ownerLimits: settings.ownerLimits, popupsEnabled: settings.popupsEnabled };
  });
}
