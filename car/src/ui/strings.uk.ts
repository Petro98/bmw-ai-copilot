/**
 * Every word the head-unit screens show, in Ukrainian (docs/design/README.md "Content"; the car mockups in
 * docs/design/mockups/{Main,AssistantMoving,Sensors,Alerts}.dc.html), and the formatting of numbers, units,
 * ages and times. The phone panel words the same things the same way (apps/companion/src/app/core/format.ts,
 * shared/alert-row/alert-row.ts); the car app cannot import the panel, so the copy is repeated here.
 */
import type { Provenance } from '@copilot/event-engine';
import type { ReadingSource, Severity, UnavailableReason, Unit } from '@copilot/vehicle-core';

export const APP_NAME = 'Copilot';

/** The header's tabs, in order (the kit adds its own Settings tab after them). */
export const TAB_LABELS = ['ПОМІЧНИК', 'ДАТЧИКИ', 'СПОВІЩЕННЯ'] as const;

/** Status marks in the header: the word when the link works, and when it does not (never colour alone). */
export const STATUS_WORDS = {
  car: { ok: 'АВТО', down: 'НЕМАЄ АВТО' },
  network: { ok: 'МЕРЕЖА', down: 'НЕМАЄ МЕРЕЖІ' },
  claude: { ok: 'CLAUDE', down: 'НЕМАЄ CLAUDE' },
} as const;

/** The six questions of the phone panel's assistant (Plan 1 Task 15), the chips while the car stands. */
export const CHIPS_PARKED: string[] = [
  'Як почувається авто?',
  'Чи можна навантажувати двигун?',
  'Що з шинами?',
  'Коли наступний сервіс?',
  'Чи є помилки?',
  'Як змінилися показники за останній місяць?',
];

/** The three chips while the car moves (docs/design/mockups/AssistantMoving.dc.html). */
export const CHIPS_MOVING: string[] = ['Стан авто', 'Чи можна навантажувати?', 'Попередження'];

export const LABEL_YOUR_QUESTION = 'ВАШЕ ПИТАННЯ';
export const LABEL_MOVING_ANSWER = 'У РУСІ · КОРОТКА ВІДПОВІДЬ';
export const LABEL_ASK = 'ЗАПИТАТИ';
export const LABEL_RECENT_ALERTS = 'ОСТАННІ СПОВІЩЕННЯ';
export const LABEL_PAIRING = 'ПІДКЛЮЧЕННЯ ДО ТЕЛЕФОНА';

export const TEXT_NO_TURN = 'Оберіть питання праворуч.';
export const TEXT_PENDING = 'Готую відповідь…';
export const TEXT_NO_ALERTS = 'Сповіщень немає.';
export const TEXT_UNAVAILABLE = 'Недоступно';
/** A tyre the car sent no pressure for, inside the tyre tile's two-by-two grid (no room for «Недоступно»). */
export const TEXT_TYRE_UNAVAILABLE = 'н/д';

/**
 * The pop-up the owner's switch «Тестове сповіщення» (app.json settings key `testPopup`) shows once, so the
 * BMW pop-up path can be checked on the car without waiting for a real alert (docs/CAR_CHECKLIST.md B11).
 */
export const TEXT_TEST_POPUP = 'Тестове сповіщення Copilot';

/** Pairing (shown on the assistant tab until the device is registered on the phone's /pair page). */
export const PAIRING_LINES: readonly [string, string] = [
  'Відскануйте код камерою телефона.',
  'На сторінці, що відкриється, підтвердьте підключення цього авто.',
];
export const PAIRING_NO_ADDRESS = 'Адресу сервера не налаштовано';
export const PAIRING_NO_ADDRESS_NOTE = 'Без неї авто не може підключитися до вашого Copilot.';

/** Tile labels (the mockups' order is in view-model.ts). */
export const TILE = {
  rpm: 'ОБЕРТИ ДВИГУНА',
  oil: 'МАСЛО',
  coolant: 'ОХОЛОДЖУВАЛЬНА РІДИНА',
  gear: 'ПЕРЕДАЧА І РЕЖИМ',
  fuel: 'ПАЛЬНЕ',
  battery: 'АКУМУЛЯТОР 12 В',
  tyresBar: 'ШИНИ, БАР',
  tyres: 'ШИНИ',
  intake: 'ТЕМПЕРАТУРА ВПУСКУ',
  range: 'ЗАПАС ХОДУ',
} as const;

/** A label too wide for its tile is written short, as the phone panel writes it, before it is ever cut. */
export const SHORT_LABEL: Record<string, string> = {
  'ОХОЛОДЖУВАЛЬНА РІДИНА': 'ОХОЛОДЖ. РІДИНА',
  'ТЕМПЕРАТУРА ВПУСКУ': 'ТЕМП. ВПУСКУ',
};

export const NOTE_BATTERY ='Рівень заряду, не напруга';
export const NOTE_TYRE_UNIT_UNKNOWN = 'Одиниця тиску невідома';

export function noteRange(range: string | null): string {
  return range === null ? 'Запас ходу: недоступно' : `Запас ходу ${range}`;
}

export function noteTyreTarget(front: string, rear: string): string {
  return front === rear ? `Ціль авто: ${front}` : `Ціль авто: ${front} і ${rear}`;
}

/** Severity as a word, beside the icon shape (docs/design/README.md). */
export const SEVERITY_WORD: Record<Severity, string> = {
  critical: 'КРИТИЧНО',
  warning: 'ПОПЕРЕДЖЕННЯ',
  info: 'ДО ВІДОМА',
};

/** Where a warning comes from (docs/design/README.md "Content"). */
export const PROVENANCE_TAG: Record<Provenance, string> = {
  'bmw-check-control': 'BMW CHECK CONTROL',
  'bmw-service': 'СЕРВІС BMW',
  'bmw-fault-status': 'ПАМ\'ЯТЬ ПОМИЛОК BMW',
  'owner-configured': 'ВАШ ЛІМІТ',
};

/** How each unit is written on screen («452 км», «2,3 бар», «об/хв»: docs/design/README.md, Sensors mockup). */
export const UNIT_TEXT: Record<Unit, string> = {
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

/** Decimals per unit: whole numbers, one fixed decimal for pressure in bar and for voltage («2,0 бар»). */
const UNIT_DECIMALS: Partial<Record<Unit, number>> = { bar: 1, V: 1 };

const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  'not-reported': 'Авто не надіслало це значення.',
  'invalid-value': 'Авто надіслало недійсне значення.',
  'not-on-this-vehicle': 'На цьому авто цього показника немає.',
  'diagnostics-disabled': 'Потрібне діагностичне читання. Воно вимкнене в налаштуваннях.',
  'stale': 'Значення застаріло: авто давно його не оновлювало.',
};

/** The reason a reading is unavailable, in words, for the line under «Недоступно». */
export function unavailableText(reason: UnavailableReason): string {
  return UNAVAILABLE_TEXT[reason] ?? UNAVAILABLE_TEXT['not-reported'];
}

const SOURCE_TEXT: Record<ReadingSource, string> = {
  'passive-signal': 'Сигнал авто',
  'polled-signal': 'Опитування',
  'diagnostic-read': 'Діагностика',
  'mock': 'Демо',
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Younger than this a reading is «щойно» (the mockup's word for a value that arrives every second). */
const JUST_NOW_MS = 2 * SECOND;

/** «Сигнал авто · 4 с тому»: where a reading came from and how old it is. */
export function provenanceLine(source: ReadingSource, ageMs: number): string {
  return `${SOURCE_TEXT[source] ?? SOURCE_TEXT['passive-signal']} · ${ageText(ageMs)}`;
}

/** «щойно», «4 с тому», «2 хв тому», «1 год тому», «3 дн тому». A negative age (clock jump) is «щойно». */
export function ageText(ageMs: number): string {
  if (!(ageMs >= JUST_NOW_MS)) return 'щойно';
  if (ageMs < MINUTE) return `${Math.floor(ageMs / SECOND)} с тому`;
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE)} хв тому`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)} год тому`;
  return `${Math.floor(ageMs / DAY)} дн тому`;
}

/** A number with its unit's precision: decimal comma, a space between thousands («1 850», «2,3»). */
export function formatValue(value: number, unit: Unit | null): string {
  const decimals = unit ? UNIT_DECIMALS[unit] ?? 0 : 1;
  if (!isFinite(value)) return String(value);
  let digits = Math.abs(value).toFixed(decimals);
  if (unit === null && digits.indexOf('.') >= 0) digits = digits.replace(/\.?0+$/, '');
  const negative = value < 0 && /[1-9]/.test(digits);
  const parts = digits.split('.');
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (negative ? '-' : '') + grouped + (parts[1] ? ',' + parts[1] : '');
}

/** The unit as written on screen, or null. */
export function unitText(unit: Unit | null): string | null {
  return unit ? UNIT_TEXT[unit] ?? null : null;
}

const MONTHS_GENITIVE = [
  'СІЧНЯ', 'ЛЮТОГО', 'БЕРЕЗНЯ', 'КВІТНЯ', 'ТРАВНЯ', 'ЧЕРВНЯ',
  'ЛИПНЯ', 'СЕРПНЯ', 'ВЕРЕСНЯ', 'ЖОВТНЯ', 'ЛИСТОПАДА', 'ГРУДНЯ',
];

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** «12:41» (local time of the head unit). */
export function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Day = 'today' | 'yesterday' | 'earlier';

function dayOf(at: number, now: number): Day {
  const when = new Date(at);
  const today = new Date(now);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(when, today)) return 'today';
  if (same(when, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return 'yesterday';
  return 'earlier';
}

function dateText(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]}`;
}

/** «АКТИВНЕ З 12:36», «АКТИВНЕ З УЧОРА», «АКТИВНЕ З 9 ЛИСТОПАДА». */
export function activeSince(at: number, now: number): string {
  const day = dayOf(at, now);
  return 'АКТИВНЕ З ' + (day === 'today' ? clock(at) : day === 'yesterday' ? 'УЧОРА' : dateText(at));
}

/** «ЗНЯТО О 12:39», «ЗНЯТО ВЧОРА», «ЗНЯТО 9 ЛИСТОПАДА»: when the car stopped reporting it. */
export function clearedAt(at: number, now: number): string {
  const day = dayOf(at, now);
  return 'ЗНЯТО ' + (day === 'today' ? 'О ' + clock(at) : day === 'yesterday' ? 'ВЧОРА' : dateText(at));
}
