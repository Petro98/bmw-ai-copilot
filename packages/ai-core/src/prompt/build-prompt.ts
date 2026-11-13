import type { AlertEvent, OwnerLimits, Provenance } from '@copilot/event-engine';
import { isMoving } from '@copilot/vehicle-core';
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

function headerLine(input: PromptInput): string {
  const style = input.style === 'spoken' ? 'СТИЛЬ: усний' : 'СТИЛЬ: письмовий';
  const moving = isMoving(input.snapshot);
  // Unknown motion gets the short rule: the driver may be on the road.
  const motion = moving === null ? 'РУХ: невідомо' : moving ? 'РУХ: авто рухається' : 'РУХ: авто стоїть';
  return `${style}. ${motion}. ${moving === false ? LENGTH_LONG : LENGTH_SHORT}`;
}

function alertsSection(alerts: AlertEvent[]): string {
  const lines = alerts
    .filter((a) => a.active)
    .map((a) => {
      const detail = a.detail === null ? '' : ` — «${promptSafeText(a.detail)}»`;
      return `${PROVENANCE_TAG[a.provenance]}, ${SEVERITY_UK[a.severity]}: «${promptSafeText(a.title)}»${detail}`;
    });
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
 * volatile context in a fixed order (style and motion with the length rule, vehicle label,
 * «ДАНІ АВТО», «АКТИВНІ СПОВІЩЕННЯ», «ЛІМІТИ ВЛАСНИКА», «ІСТОРІЯ»). Vehicle text only ever appears
 * inside `system[1]`, as data.
 * `messages`: `input.history` (expected oldest first) as user/assistant pairs, then the question,
 * passed through unchanged.
 */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const sections: string[] = [headerLine(input)];
  if (input.vehicleLabel !== null && promptSafeText(input.vehicleLabel) !== '') {
    sections.push(`АВТО: ${promptSafeText(input.vehicleLabel)}`);
  }
  sections.push(`ДАНІ АВТО:\n${renderSnapshot(input.snapshot, input.now)}`);
  sections.push(`АКТИВНІ СПОВІЩЕННЯ:\n${alertsSection(input.alerts)}`);
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
