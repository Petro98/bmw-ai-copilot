import { formatPromptNumber } from '@copilot/ai-core';
import { findSignal, type Unit } from '@copilot/vehicle-core';
import type { DailySummary, TelemetryKey } from '../stores/telemetry-store';

/**
 * Keys in the order they are listed, with the Ukrainian names the prompt's «ДАНІ АВТО» block uses
 * (packages/ai-core/src/prompt/render-snapshot.ts), so Claude can relate the two.
 */
const KEYS: ReadonlyArray<[TelemetryKey, string]> = [
  ['oilTemp', 'Температура масла'],
  ['coolantTemp', 'Температура охолоджувальної рідини'],
  ['battery12vCharge', 'Заряд акумулятора 12 В'],
  ['fuelLevel', 'Пальне в баку'],
  ['range', 'Запас ходу'],
  ['odometer', 'Пробіг'],
  ['speed', 'Швидкість'],
  ['engineRpm', 'Оберти двигуна'],
];

/** Same Ukrainian unit words as the prompt's vehicle block (render-snapshot.ts). */
const UNIT_UK: Record<Unit, string> = {
  rpm: 'об/хв', 'km/h': 'км/год', '°C': '°C', '°F': '°F', l: 'л', km: 'км', mi: 'миль',
  '%': '%', bar: 'бар', psi: 'psi', kPa: 'кПа', V: 'В',
};

/**
 * The unit of a telemetry key is the one the signal catalogue decodes it into (packages/vehicle-core/src/catalogue.ts,
 * sourced there from the reference repository). A key without a fixed catalogue unit is shown without one.
 */
function unitSuffix(key: TelemetryKey): string {
  const unit = findSignal(key)?.unit ?? null;
  return unit === null ? '' : ` ${UNIT_UK[unit]}`;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * The «ІСТОРІЯ» text of the prompt from the daily roll-ups (`TelemetryStore.dailySummaries`, oldest first):
 * per key, the lowest and highest value over the covered days and the daily average on the first and last
 * day that has the key. The roll-ups may be old (they are kept after raw samples are pruned), so the text names
 * the first and last day it covers and, when given, today's date: old data is never presented as current.
 * Null with fewer than two days, or when no key holds a finite value.
 */
export function trendSummary(days: ReadonlyArray<DailySummary>, today?: string): string | null {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (sorted.length < 2) return null;

  const lines: string[] = [];
  for (const [key, name] of KEYS) {
    const present = sorted
      .map((d) => ({ day: d.day, v: d.values[key] }))
      .filter((d): d is { day: string; v: { min: number; max: number; avg: number } } =>
        d.v !== undefined && finite(d.v.min) && finite(d.v.max) && finite(d.v.avg));
    if (present.length === 0) continue;
    const unit = unitSuffix(key);
    const min = Math.min(...present.map((d) => d.v.min));
    const max = Math.max(...present.map((d) => d.v.max));
    const first = present[0];
    const last = present[present.length - 1];
    const avg = (d: { day: string; v: { avg: number } }): string => `${formatPromptNumber(d.v.avg)}${unit} (${d.day})`;
    const averages = present.length === 1 ? `середнє за добу ${avg(first)}` : `середнє за добу ${avg(first)}, потім ${avg(last)}`;
    lines.push(`${name}: від ${formatPromptNumber(min)} до ${formatPromptNumber(max)}${unit}; ${averages}`);
  }
  if (lines.length === 0) return null;

  const header = `Добові підсумки збережених даних за ${sorted.length} дн. з даними, з ${sorted[0].day} по ${sorted[sorted.length - 1].day} (UTC).`;
  const note = today === undefined
    ? 'Це минулі дані, а не поточні показники.'
    : `Сьогодні ${today}. Це минулі дані, а не поточні показники.`;
  return [`${header} ${note}`, ...lines].join('\n');
}
