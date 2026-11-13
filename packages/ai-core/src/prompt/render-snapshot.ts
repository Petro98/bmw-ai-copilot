import {
  ageMs,
  type Reading, type Severity, type ServiceStatus, type TyreSet, type Unit, type UnavailableReason,
  type VehicleCondition, type VehicleSnapshot,
} from '@copilot/vehicle-core';

/** A reading older than this gets its age next to it. */
const STALE_AFTER_MS = 60_000;

const UNIT_UK: Record<Unit, string> = {
  rpm: 'об/хв', 'km/h': 'км/год', '°C': '°C', '°F': '°F', l: 'л', km: 'км', mi: 'миль',
  '%': '%', bar: 'бар', psi: 'psi', kPa: 'кПа', V: 'В',
};

const REASON_UK: Record<UnavailableReason, string> = {
  'not-reported': 'авто не повідомило',
  'invalid-value': 'недійсне значення',
  'not-on-this-vehicle': 'немає на цьому авто',
  'diagnostics-disabled': 'потрібне діагностичне читання, вимкнено',
  stale: 'дані застарілі',
};

const CONDITION_UK: Record<VehicleCondition, string> = {
  parked: 'припарковане', standby: 'режим очікування', living: 'увімкнене без запалювання',
  'ignition-on': 'запалювання увімкнене', starting: 'запуск двигуна', driving: 'їзда', stopping: 'зупинка двигуна',
};

const SEVERITY_UK: Record<Severity, string> = { critical: 'критичне', warning: 'попередження', info: 'інформаційне' };

const SERVICE_STATUS_UK: Record<ServiceStatus, string> = {
  ok: 'в нормі', 'due-soon': 'скоро', overdue: 'прострочено', unknown: 'стан невідомий',
};

const WHEELS: ReadonlyArray<[keyof TyreSet<unknown>, string]> = [
  ['frontLeft', 'передня ліва'], ['frontRight', 'передня права'], ['rearLeft', 'задня ліва'], ['rearRight', 'задня права'],
];

/** At most one decimal, decimal comma (docs/design/README.md: «2,3 бар»). */
export function formatPromptNumber(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toString().replace('.', ',');
}

/**
 * Car-supplied text as a single quotable line: control characters and line breaks collapse to
 * spaces (so a text cannot fake a new prompt section) and guillemets are neutralised (so it cannot
 * close its own quotation).
 */
export function promptSafeText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoted(text: string): string {
  return `«${promptSafeText(text)}»`;
}

interface Collected { lines: string[]; unavailable: string[] }

function ageSuffix(reading: Reading<unknown>, now: number): string {
  const age = ageMs(reading, now);
  return age !== null && age > STALE_AFTER_MS ? ` (${Math.floor(age / 60_000)} хв тому)` : '';
}

function addNumber(out: Collected, name: string, reading: Reading<number>, now: number): void {
  if (!reading.available) {
    out.unavailable.push(`${name} (${REASON_UK[reading.reason]})`);
    return;
  }
  if (typeof reading.value !== 'number' || !Number.isFinite(reading.value)) {
    out.unavailable.push(`${name} (${REASON_UK['invalid-value']})`);
    return;
  }
  const unit = reading.unit === null ? ' (одиниця не повідомлена)' : ` ${UNIT_UK[reading.unit]}`;
  out.lines.push(`${name}: ${formatPromptNumber(reading.value)}${unit}${ageSuffix(reading, now)}`);
}

function addWord<T>(out: Collected, name: string, reading: Reading<T>, now: number, word: (value: T) => string): void {
  if (!reading.available) {
    out.unavailable.push(`${name} (${REASON_UK[reading.reason]})`);
    return;
  }
  out.lines.push(`${name}: ${word(reading.value)}${ageSuffix(reading, now)}`);
}

/**
 * The «ДАНІ АВТО» block body: one line per available reading (`<name>: <value> <unit>`, with
 * `(<n> хв тому)` when older than 60 s), then `Недоступно: …` naming every unavailable reading with
 * its reason, then Check Control, service items and fault codes when the car reported them.
 * Values are never defaulted or estimated; car texts are quoted single lines.
 */
export function renderSnapshot(snapshot: VehicleSnapshot, now: number): string {
  const s = snapshot;
  const out: Collected = { lines: [], unavailable: [] };

  addNumber(out, 'Температура масла', s.oilTemp, now);
  addNumber(out, 'Температура охолоджувальної рідини', s.coolantTemp, now);
  addNumber(out, 'Швидкість', s.speed, now);
  addNumber(out, 'Оберти двигуна', s.engineRpm, now);
  addWord(out, 'Передача', s.gear, now, (v) => promptSafeText(String(v)));
  addWord(out, 'Положення селектора', s.gearStage, now, (v) => v);
  addWord(out, 'Режим їзди', s.driveMode, now, (v) => quoted(String(v)));
  addWord(out, 'Стан авто', s.condition, now, (v) => CONDITION_UK[v] ?? promptSafeText(String(v)));
  addNumber(out, 'Пальне в баку', s.fuelLevel, now);
  addNumber(out, 'Запас ходу', s.range, now);
  addNumber(out, 'Пробіг', s.odometer, now);
  addNumber(out, 'Заряд акумулятора 12 В', s.battery12vCharge, now);
  addNumber(out, 'Напруга акумулятора 12 В', s.battery12vVoltage, now);
  addNumber(out, 'Температура впуску', s.intakeTemp, now);
  addNumber(out, 'Тиск наддуву', s.boostPressure, now);
  addNumber(out, 'Навантаження двигуна', s.engineLoad, now);
  for (const [wheel, uk] of WHEELS) addNumber(out, `Тиск у шині (${uk})`, s.tyrePressure[wheel], now);
  for (const [wheel, uk] of WHEELS) addNumber(out, `Цільовий тиск шини за даними авто (${uk})`, s.tyrePressureTarget[wheel], now);

  const lists: string[] = [];

  if (s.checkControl.available) {
    const age = ageSuffix(s.checkControl, now);
    if (s.checkControl.value.length === 0) lists.push(`Check Control: немає активних${age}`);
    for (const m of s.checkControl.value) {
      const body = m.text === null || promptSafeText(m.text) === ''
        ? `повідомлення ${m.id}, текст недоступний`
        : `повідомлення ${m.id}: ${quoted(m.text)}`;
      lists.push(`Check Control, ${SEVERITY_UK[m.severity] ?? SEVERITY_UK.warning}: ${body}${age}`);
    }
  } else {
    out.unavailable.push(`Check Control (${REASON_UK[s.checkControl.reason]})`);
  }

  if (s.serviceItems.available) {
    const age = ageSuffix(s.serviceItems, now);
    if (s.serviceItems.value.length === 0) lists.push(`Сервіс: пунктів немає${age}`);
    for (const item of s.serviceItems.value) {
      const name = item.name === null ? `пункт ${item.id}` : quoted(item.name);
      const due = item.dueText === null ? '' : `, ${quoted(item.dueText)}`;
      lists.push(`Сервіс: ${name}, ${SERVICE_STATUS_UK[item.status] ?? SERVICE_STATUS_UK.unknown}${due}${age}`);
    }
  } else {
    out.unavailable.push(`Сервісні пункти (${REASON_UK[s.serviceItems.reason]})`);
  }

  if (s.faultCodes.available) {
    const age = ageSuffix(s.faultCodes, now);
    if (s.faultCodes.value.length === 0) lists.push(`Коди помилок: немає${age}`);
    for (const f of s.faultCodes.value) {
      const text = f.text === null ? 'текст недоступний' : quoted(f.text);
      const active = f.activeNow ? 'активна зараз' : 'не активна зараз';
      const lamp = f.warningLamp ? 'лампа попередження запитана' : 'лампа попередження не запитана';
      lists.push(`Код помилки ${promptSafeText(f.code)} (блок ${promptSafeText(f.ecu)}): ${text}; ${active}; ${lamp}${age}`);
    }
  } else {
    out.unavailable.push(`Коди помилок (${REASON_UK[s.faultCodes.reason]})`);
  }

  const lines = [...out.lines];
  if (out.unavailable.length > 0) lines.push(`Недоступно: ${out.unavailable.join(', ')}`);
  return [...lines, ...lists].join('\n');
}
