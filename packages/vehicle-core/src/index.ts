export * from './clock';
export * from './reading';
export * from './snapshot';
export * from './provider';

/** Mock scenario ids (the scenarios themselves are in Task 3's `mock/scenarios.ts`). */
export type ScenarioId =
  | 'cold-start' | 'steady-cruise' | 'spirited' | 'overheat-check-control' | 'low-tyre'
  | 'weak-battery' | 'stored-faults' | 'signals-missing' | 'parked';
