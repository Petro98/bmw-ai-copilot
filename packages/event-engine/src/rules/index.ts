import { isReversing } from '@copilot/vehicle-core';
import { EngineOptions, Rule } from '../types';
import { TEN_MINUTES_MS, checkControlRule } from './check-control';
import { faultStatusRule } from './fault-status';
import { ownerLimitsRule } from './owner-limits';
import { serviceRule } from './service';

export { TEN_MINUTES_MS, checkControlRule } from './check-control';
export { THIRTY_DAYS_MS, serviceRule } from './service';
export { faultStatusRule } from './fault-status';
export { ownerLimitsRule } from './owner-limits';

/** The four provenance-tagged rules. None carries a built-in numeric alert threshold. */
export function defaultRules(): Rule[] {
  return [checkControlRule(), serviceRule(), faultStatusRule(), ownerLimitsRule()];
}

/** Engine options for the assistant: at most 6 raised events per 10 minutes, nothing raised while reversing. */
export function defaultEngineOptions(): EngineOptions {
  return {
    rules: defaultRules(),
    maxRaisedPerWindow: 6,
    windowMs: TEN_MINUTES_MS,
    historySize: 200,
    suppress: isReversing,
  };
}
