/** Injected time source. The shared packages never read a clock of their own. */
export interface Clock { now(): number }                       // epoch milliseconds

/** Injected timers. The shared packages never create a timer of their own. */
export interface TimerApi {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
