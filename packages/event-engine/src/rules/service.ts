import { Candidate, Rule, RuleContext } from '../types';

/** Cooldown of the service rule: a CBS item is announced at most once per state change (spec §7). */
export const THIRTY_DAYS_MS = 2_592_000_000;

/** One candidate per BMW service (CBS) item that is due soon or overdue; the state is part of the key. */
export function serviceRule(): Rule {
  return {
    id: 'service',
    provenance: 'bmw-service',
    dwellMs: 0,
    cooldownMs: THIRTY_DAYS_MS,
    evaluate(ctx: RuleContext): Candidate[] | null {
      const reading = ctx.snapshot.serviceItems;
      // An unavailable list is unknown, not empty: the engine keeps this rule's alerts as they are.
      if (!reading.available || !Array.isArray(reading.value)) return null;
      const out: Candidate[] = [];
      for (const item of reading.value) {
        if (!item || (item.status !== 'due-soon' && item.status !== 'overdue')) continue;
        const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name : `Сервіс ${item.id}`;
        const due = typeof item.dueText === 'string' && item.dueText.trim() !== '' ? item.dueText : null;
        out.push({
          dedupKey: `service:${item.id}:${item.status}`,
          severity: item.status === 'overdue' ? 'warning' : 'info',
          title: due === null ? name : `${name}: ${due}`,
          detail: null,
        });
      }
      return out;
    },
  };
}
