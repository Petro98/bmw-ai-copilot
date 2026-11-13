import { Candidate, Rule, RuleContext } from '../types';
import { TEN_MINUTES_MS } from './check-control';

/** One warning per fault code that is active now with the warning lamp requested (spec §7). */
export function faultStatusRule(): Rule {
  return {
    id: 'fault-status',
    provenance: 'bmw-fault-status',
    dwellMs: 0,
    cooldownMs: TEN_MINUTES_MS,
    evaluate(ctx: RuleContext): Candidate[] {
      const reading = ctx.snapshot.faultCodes;
      if (!reading.available || !Array.isArray(reading.value)) return [];
      const out: Candidate[] = [];
      for (const fault of reading.value) {
        if (!fault || fault.activeNow !== true || fault.warningLamp !== true) continue;
        const text = typeof fault.text === 'string' ? fault.text.trim() : '';
        out.push({
          dedupKey: `fault:${fault.ecu}:${fault.code}`,
          severity: 'warning',
          title: text !== '' ? text : `Помилка ${fault.code} (${fault.ecu})`,
          detail: null,
        });
      }
      return out;
    },
  };
}
