import type { Reading, Unit, UnavailableReason } from '@copilot/vehicle-core';

export interface FormattedReading { text: string; unit: string | null; note: string | null; available: boolean }

/** Between groups of thousands (Ukrainian typography). */
const THOUSANDS_SEPARATOR = ' ';
const DECIMAL_SEPARATOR = ',';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How each unit is written on screen (docs/design/README.md: «452 км», «2,3 бар»; mockup Sensors: «об/хв»). */
const UNIT_TEXT: Record<Unit, string> = {
  'rpm': 'об/хв',
  'km/h': 'км/год',
  '°C': '°C',
  '°F': '°F',
  'l': 'л',
  'km': 'км',
  'mi': 'миль',
  '%': '%',
  'bar': 'бар',
  'psi': 'psi',
  'kPa': 'кПа',
  'V': 'В',
};

/** Display precision per unit: whole numbers, or one fixed decimal for pressure in bar and voltage («2,0 бар»). */
const UNIT_DECIMALS: Partial<Record<Unit, { decimals: number; fixed: boolean }>> = {
  'rpm': { decimals: 0, fixed: true },
  'km/h': { decimals: 0, fixed: true },
  '°C': { decimals: 0, fixed: true },
  '°F': { decimals: 0, fixed: true },
  'l': { decimals: 0, fixed: true },
  'km': { decimals: 0, fixed: true },
  'mi': { decimals: 0, fixed: true },
  '%': { decimals: 0, fixed: true },
  'psi': { decimals: 0, fixed: true },
  'kPa': { decimals: 0, fixed: true },
  'bar': { decimals: 1, fixed: true },
  'V': { decimals: 1, fixed: true },
};

const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  'not-reported': 'Авто не надіслало це значення.',
  'invalid-value': 'Авто надіслало недійсне значення.',
  'not-on-this-vehicle': 'На цьому авто цього показника немає.',
  'diagnostics-disabled': 'Потрібне діагностичне читання. Воно вимкнене в налаштуваннях.',
  'stale': 'Значення застаріло: авто давно його не оновлювало.',
};

/** Decimal comma, narrow no-break space between thousands, at most `maxDecimals` decimals, no trailing zeros. */
export function formatNumber(value: number, maxDecimals = 1): string {
  return formatDecimal(value, maxDecimals, false);
}

/** The reason a reading is unavailable, in words, for the line under «Недоступно». */
export function unavailableText(reason: UnavailableReason): string {
  return UNAVAILABLE_TEXT[reason];
}

/** A reading as text for a tile: value and unit, or «Недоступно» and the reason; an age note when older than a minute. */
export function formatReading(reading: Reading<number | string>, now: number): FormattedReading {
  if (!reading.available) {
    return { text: 'Недоступно', unit: null, note: unavailableText(reading.reason), available: false };
  }
  const unit = reading.unit;
  let text: string;
  if (typeof reading.value === 'number') {
    const precision = unit ? UNIT_DECIMALS[unit] : undefined;
    text = precision ? formatDecimal(reading.value, precision.decimals, precision.fixed) : formatNumber(reading.value);
  } else {
    text = reading.value;
  }
  return { text, unit: unit ? UNIT_TEXT[unit] : null, note: ageNote(now - reading.at), available: true };
}

function ageNote(ageMs: number): string | null {
  if (!(ageMs >= MINUTE_MS)) return null;            // also covers a clock that went backwards
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)} хв тому`;
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)} год тому`;
  return `${Math.floor(ageMs / DAY_MS)} дн тому`;
}

function formatDecimal(value: number, decimals: number, fixed: boolean): string {
  if (!Number.isFinite(value)) return String(value);
  let digits = Math.abs(value).toFixed(decimals);
  if (!fixed && digits.includes('.')) digits = digits.replace(/\.?0+$/, '');
  const negative = value < 0 && /[1-9]/.test(digits);
  const [whole, fraction] = digits.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
  return (negative ? '-' : '') + grouped + (fraction ? DECIMAL_SEPARATOR + fraction : '');
}
