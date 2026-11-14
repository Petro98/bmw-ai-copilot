import { Candidate, Rule, RuleContext } from '../types';

/** Default cooldown of the event rules (plan 1, Task 5; spec §6.4: cooldown at least 10 min per rule). */
export const TEN_MINUTES_MS = 600_000;

/**
 * Relays every active BMW Check Control message. The car's own text is the title; without a text the
 * title names only the id (spec §7: Claude must not guess the meaning). Severity is the message's.
 */
export function checkControlRule(): Rule {
  return {
    id: 'check-control',
    provenance: 'bmw-check-control',
    dwellMs: 4000,
    cooldownMs: TEN_MINUTES_MS,
    evaluate(ctx: RuleContext): Candidate[] | null {
      const reading = ctx.snapshot.checkControl;
      // An unavailable list is unknown, not empty: the engine keeps this rule's alerts as they are.
      if (!reading.available || !Array.isArray(reading.value)) return null;
      const out: Candidate[] = [];
      for (const message of reading.value) {
        if (!message) continue;
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        out.push({
          dedupKey: `cc:${message.id}`,
          severity: message.severity,
          title: text !== '' ? text : `Повідомлення Check Control ${message.id}`,
          detail: null,
        });
      }
      return out;
    },
  };
}
