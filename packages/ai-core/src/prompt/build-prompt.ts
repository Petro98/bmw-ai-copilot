import type { AlertEvent, OwnerLimits, Provenance } from '@copilot/event-engine';
import {
  isMoving, isMovingNow, MOTION_FRESH_MS, type Reading, type TyreSet, type VehicleSnapshot,
} from '@copilot/vehicle-core';
import type { BuiltPrompt, PromptInput, SystemBlock } from '../types';
import { STATIC_INSTRUCTIONS } from './instructions';
import { promptSafeText, renderSnapshot } from './render-snapshot';

/** `system[0]`: the frozen instructions and the request's only cache breakpoint. */
const CACHED_BLOCK: SystemBlock = Object.freeze({
  type: 'text' as const,
  text: STATIC_INSTRUCTIONS,
  cache_control: Object.freeze({ type: 'ephemeral' as const }),
});

/**
 * Provenance tags as in docs/design/README.md (Content), the same words the panel shows. A fault code read
 * from a control unit's fault memory is «ПАМ'ЯТЬ ПОМИЛОК BMW»; the only rule with this provenance raises it
 * when the car marks the code active now with the warning lamp requested (spec §7).
 */
const PROVENANCE_TAG: Record<Provenance, string> = {
  'bmw-check-control': 'BMW CHECK CONTROL',
  'bmw-service': 'СЕРВІС BMW',
  'bmw-fault-status': 'ПАМ\'ЯТЬ ПОМИЛОК BMW',
  'owner-configured': 'ВАШ ЛІМІТ',
};

const SEVERITY_UK = { critical: 'критичне', warning: 'попередження', info: 'інформаційне' } as const;

const LENGTH_SHORT = 'Довжина відповіді: не більше 3 коротких речень, разом до 45 слів.';
const LENGTH_LONG = 'Довжина відповіді: не більше 8 речень, разом до 160 слів.';

/**
 * A car whose last data showed it moving keeps the short length rule for this long after that data, even though it
 * is no longer described as moving: missed uploads mid-drive, or a head-unit clock up to two minutes slow (the
 * backend leaves that skew uncorrected), must not hand a driver a long answer. A prompt-wording window, not a vehicle
 * limit.
 */
const QUIET_WHILE_MOVING_SHORT_MS = 15 * 60_000;

/** At most this many active alerts are listed in the prompt, newest first; the rest are only counted. */
const MAX_PROMPT_ALERTS = 20;

/** An alert raised within this long before `now` is described as just raised. */
const JUST_RAISED_MS = 60_000;

const DEMO_LINE =
  'УВАГА: дані авто й сповіщення нижче демонстраційні — це імітоване авто, а не показники справжнього автомобіля. ' +
  'Обовʼязково скажи про це у відповіді.';

/** A non-negative age as a short Ukrainian duration: minutes under two hours, hours under two days, then days. */
function formatAge(ms: number): string {
  const age = ms > 0 ? ms : 0;
  if (age < 120 * 60_000) return `${Math.floor(age / 60_000)} хв`;
  if (age < 48 * 3_600_000) return `${Math.floor(age / 3_600_000)} год`;
  return `${Math.floor(age / 86_400_000)} дн`;
}

/** Every reading of the snapshot, the per-wheel ones included. */
function readingsOf(snapshot: VehicleSnapshot): Array<Reading<unknown>> {
  const out: Array<Reading<unknown>> = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'takenAt' || typeof value !== 'object' || value === null) continue;
    if ('available' in value) out.push(value as Reading<unknown>);
    else out.push(...Object.values(value as TyreSet<Reading<unknown>>));
  }
  return out;
}

/** True when any available reading comes from the mock source (scripted demonstration data, not a car). */
function hasMockReading(snapshot: VehicleSnapshot): boolean {
  return readingsOf(snapshot).some((r) => r.available && r.source === 'mock');
}

/** Receive time of the newest available reading, or null when nothing is available. */
function newestReadingAt(snapshot: VehicleSnapshot): number | null {
  let newest: number | null = null;
  for (const r of readingsOf(snapshot)) {
    if (r.available && (newest === null || r.at > newest)) newest = r.at;
  }
  return newest;
}

/**
 * Style, motion and the length rule. Motion comes only from a fresh speed reading (`isMovingNow`): a car whose
 * last batch carried a speed but which has sent nothing for longer than MOTION_FRESH_MS is described as not
 * reporting, with the age of its last data. It gets the standing length rule only when that last speed was not
 * moving, or the last data is older than QUIET_WHILE_MOVING_SHORT_MS; otherwise the driver may still be on the
 * road and the short rule stays. Any other unknown motion (speed unavailable, or only the speed is stale while the
 * car keeps reporting) keeps the short rule too.
 */
function headerLine(input: PromptInput): string {
  const style = input.style === 'spoken' ? 'СТИЛЬ: усний' : 'СТИЛЬ: письмовий';
  const { snapshot, now } = input;
  const moving = isMovingNow(snapshot, now);
  if (moving !== null) {
    return moving ? `${style}. РУХ: авто рухається. ${LENGTH_SHORT}` : `${style}. РУХ: авто стоїть. ${LENGTH_LONG}`;
  }
  if (snapshot.speed.available) {
    const newest = newestReadingAt(snapshot) ?? snapshot.speed.at;
    const quietFor = now - newest;
    if (quietFor > MOTION_FRESH_MS) {
      const mayBeOnRoad = isMoving(snapshot) === true && quietFor <= QUIET_WHILE_MOVING_SHORT_MS;
      const length = mayBeOnRoad ? LENGTH_SHORT : LENGTH_LONG;
      return `${style}. РУХ: невідомо, авто зараз не надсилає даних, останні дані ${formatAge(quietFor)} тому. ${length}`;
    }
    return `${style}. РУХ: невідомо, дані про швидкість застарілі. ${LENGTH_SHORT}`;
  }
  return `${style}. РУХ: невідомо. ${LENGTH_SHORT}`;
}

/** When the alert was raised, so that an old alert is not read as new. A raise time after `now` counts as just now. */
function raisedWhen(at: number, now: number): string {
  const age = now - at;
  return age <= JUST_RAISED_MS ? 'зʼявилося щойно' : `зʼявилося ${formatAge(age)} тому`;
}

/** Active alerts, newest first, at most MAX_PROMPT_ALERTS of them, then one line counting the rest. */
function alertsSection(alerts: AlertEvent[], now: number): string {
  const active = alerts.filter((a) => a.active).sort((a, b) => b.at - a.at);
  const lines = active.slice(0, MAX_PROMPT_ALERTS).map((a) => {
    const detail = a.detail === null ? '' : ` — «${promptSafeText(a.detail)}»`;
    return `${PROVENANCE_TAG[a.provenance]}, ${SEVERITY_UK[a.severity]}: «${promptSafeText(a.title)}» (${raisedWhen(a.at, now)})${detail}`;
  });
  const more = active.length - lines.length;
  if (more > 0) lines.push(`…і ще активних сповіщень, старіших за наведені: ${more}`);
  return lines.length > 0 ? lines.join('\n') : 'немає';
}

/**
 * An owner limit exactly as the owner set it, with a decimal comma. Unlike readings, limits are not
 * rounded: a 0.05 bar tyre limit (the smallest Task 13 accepts) must not be reported as 0,1 bar.
 * `toPrecision(12)` only strips binary floating-point noise.
 */
function formatLimit(n: number): string {
  const exact = Number(n.toPrecision(12));
  return (Object.is(exact, -0) ? 0 : exact).toString().replace('.', ',');
}

function limitsSection(limits: OwnerLimits): string {
  const set = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
  const lines: string[] = [];
  if (set(limits.oilTempMaxC)) lines.push(`Температура масла: не вище ${formatLimit(limits.oilTempMaxC)} °C (ліміт власника)`);
  if (set(limits.coolantTempMaxC)) lines.push(`Температура охолоджувальної рідини: не вище ${formatLimit(limits.coolantTempMaxC)} °C (ліміт власника)`);
  if (set(limits.battery12vMinPercent)) lines.push(`Заряд акумулятора 12 В: не нижче ${formatLimit(limits.battery12vMinPercent)} % (ліміт власника)`);
  if (set(limits.tyrePressureDeviationBar)) {
    lines.push(`Відхилення тиску в шині від цілі авто: не більше ${formatLimit(limits.tyrePressureDeviationBar)} бар (ліміт власника)`);
  }
  return lines.length > 0 ? lines.join('\n') : 'не задано';
}

/**
 * Builds the request prompt.
 * `system[0]` is `STATIC_INSTRUCTIONS` with the only `cache_control`; `system[1]` carries the
 * volatile context in a fixed order (style and motion with the length rule, the demonstration-data
 * warning when any reading comes from the mock source, vehicle label, «ДАНІ АВТО», «АКТИВНІ СПОВІЩЕННЯ»
 * (newest 20, each with its raise time), «ЛІМІТИ ВЛАСНИКА», «ІСТОРІЯ»). Vehicle text only ever appears
 * inside `system[1]`, as data.
 * `messages`: `input.history` (expected oldest first) as user/assistant pairs, then the question,
 * passed through unchanged.
 */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const sections: string[] = [headerLine(input)];
  // Per request, never in the cached block: scripted readings must not be presented as the car's own.
  if (hasMockReading(input.snapshot)) sections.push(DEMO_LINE);
  if (input.vehicleLabel !== null && promptSafeText(input.vehicleLabel) !== '') {
    sections.push(`АВТО: ${promptSafeText(input.vehicleLabel)}`);
  }
  sections.push(`ДАНІ АВТО:\n${renderSnapshot(input.snapshot, input.now)}`);
  sections.push(`АКТИВНІ СПОВІЩЕННЯ:\n${alertsSection(input.alerts, input.now)}`);
  sections.push(`ЛІМІТИ ВЛАСНИКА:\n${limitsSection(input.limits)}`);
  const trend = input.trendSummary === null ? '' : input.trendSummary.trim();
  sections.push(`ІСТОРІЯ:\n${trend === '' ? 'накопичених даних немає' : trend}`);

  const messages: BuiltPrompt['messages'] = [];
  for (const turn of input.history) {
    messages.push({ role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer });
  }
  messages.push({ role: 'user', content: input.question });

  return {
    system: [CACHED_BLOCK, { type: 'text', text: sections.join('\n\n') }],
    messages,
  };
}
