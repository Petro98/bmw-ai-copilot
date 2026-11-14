import { Reading, TyreSet } from '@copilot/vehicle-core';
import { Candidate, OwnerLimits, Rule, RuleContext } from '../types';
import { TEN_MINUTES_MS } from './check-control';

/*
 * Limits the owner typed in himself. There is no built-in threshold: a limit that is null (or not a finite
 * number) makes its check inert. The only numbers here are the exit margins (hysteresis) the plan gives
 * (plan 1, Task 5): an active alert stays until the value is back past the limit by that margin.
 *
 * Unknown is not gone: when the reading a set limit compares is unavailable (or not in the expected unit), the
 * key is held (ctx.hold) and its alert stays exactly as it is. A limit the owner removed clears its alert.
 */

/** Exit margin of the temperature limits, in °C. */
const TEMPERATURE_EXIT_MARGIN_C = 2;
/** Exit margin of the 12 V charge limit, in percentage points. */
const BATTERY_EXIT_MARGIN_PERCENT = 2;
/** Exit margin of the tyre-pressure deviation limit, in bar. */
const TYRE_EXIT_MARGIN_BAR = 0.05;

type Wheel = keyof TyreSet<unknown>;

const WHEELS: ReadonlyArray<{ wheel: Wheel; uk: string }> = [
  { wheel: 'frontLeft', uk: 'передня ліва' },
  { wheel: 'frontRight', uk: 'передня права' },
  { wheel: 'rearLeft', uk: 'задня ліва' },
  { wheel: 'rearRight', uk: 'задня права' },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/** The value of an available, finite reading in exactly `unit`; null otherwise (never converted or guessed). */
function valueIn(reading: Reading<number>, unit: string): number | null {
  if (!reading.available || reading.unit !== unit || !isFiniteNumber(reading.value)) return null;
  return reading.value;
}

/** Rounds to one decimal and writes it with a decimal comma; whole numbers drop the decimal unless `fixed`. */
function formatNumber(value: number, fixed: boolean): string {
  const rounded = Math.round(value * 10) / 10;
  const text = fixed ? rounded.toFixed(1) : String(rounded === 0 ? 0 : rounded);
  return text.replace('.', ',');
}

/** The limit when the owner set a usable one; null keeps the check inert. */
function limitOf(limits: OwnerLimits, name: keyof OwnerLimits): number | null {
  const limit = limits ? limits[name] : null;
  return isFiniteNumber(limit) ? limit : null;
}

function maxTemperature(
  ctx: RuleContext, name: 'oilTempMaxC' | 'coolantTempMaxC', reading: Reading<number>, label: string,
): Candidate | null {
  const limit = limitOf(ctx.limits, name);
  if (limit === null) return null;
  const dedupKey = `limit:${name}`;
  const value = valueIn(reading, '°C');
  if (value === null) {
    ctx.hold(dedupKey);
    return null;
  }
  const over = ctx.isActive(dedupKey) ? value > limit - TEMPERATURE_EXIT_MARGIN_C : value > limit;
  if (!over) return null;
  return {
    dedupKey,
    severity: 'warning',
    title: `${label} ${formatNumber(value, false)} °C — вище вашого ліміту ${formatNumber(limit, false)} °C`,
    detail: null,
  };
}

function minBattery(ctx: RuleContext): Candidate | null {
  const limit = limitOf(ctx.limits, 'battery12vMinPercent');
  if (limit === null) return null;
  const dedupKey = 'limit:battery12vMinPercent';
  const value = valueIn(ctx.snapshot.battery12vCharge, '%');
  if (value === null) {
    ctx.hold(dedupKey);
    return null;
  }
  const under = ctx.isActive(dedupKey) ? value < limit + BATTERY_EXIT_MARGIN_PERCENT : value < limit;
  if (!under) return null;
  return {
    dedupKey,
    severity: 'warning',
    title: `Акумулятор 12 В ${formatNumber(value, false)} % — нижче вашого ліміту ${formatNumber(limit, false)} %`,
    detail: null,
  };
}

/** Deviation of each wheel from the car's own target; only when both are available in bar, else the wheel is held. */
function tyreDeviation(ctx: RuleContext): Candidate[] {
  const limit = limitOf(ctx.limits, 'tyrePressureDeviationBar');
  if (limit === null) return [];
  const out: Candidate[] = [];
  for (const { wheel, uk } of WHEELS) {
    const dedupKey = `limit:tyre:${wheel}`;
    const pressure = valueIn(ctx.snapshot.tyrePressure[wheel], 'bar');
    const target = valueIn(ctx.snapshot.tyrePressureTarget[wheel], 'bar');
    if (pressure === null || target === null) {
      ctx.hold(dedupKey);
      continue;
    }
    const deviation = Math.abs(pressure - target);
    const off = ctx.isActive(dedupKey) ? deviation > limit - TYRE_EXIT_MARGIN_BAR : deviation > limit;
    if (!off) continue;
    out.push({
      dedupKey,
      severity: 'warning',
      title: `Тиск у шині (${uk}) ${formatNumber(pressure, true)} бар, ціль авто ${formatNumber(target, true)} бар`,
      detail: null,
    });
  }
  return out;
}

/** The owner's own limits: oil and coolant temperature, 12 V charge and tyre-pressure deviation. */
export function ownerLimitsRule(): Rule {
  return {
    id: 'owner-limits',
    provenance: 'owner-configured',
    dwellMs: 5000,
    cooldownMs: TEN_MINUTES_MS,
    evaluate(ctx: RuleContext): Candidate[] {
      const s = ctx.snapshot;
      const out: Candidate[] = [];
      const oil = maxTemperature(ctx, 'oilTempMaxC', s.oilTemp, 'Масло');
      if (oil) out.push(oil);
      const coolant = maxTemperature(ctx, 'coolantTempMaxC', s.coolantTemp, 'Охолоджувальна рідина');
      if (coolant) out.push(coolant);
      const battery = minBattery(ctx);
      if (battery) out.push(battery);
      return out.concat(tyreDeviation(ctx));
    },
  };
}
