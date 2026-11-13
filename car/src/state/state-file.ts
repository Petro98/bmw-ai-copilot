/**
 * The app's one small state file: the event engine's dwell and cooldown memory (so a restart mid-drive does
 * not repeat an alert), the owner's limits and pop-up settings as last fetched, and the device id and secret
 * the car pairs with, and whether the backend has ever accepted that device (`paired`: the pairing panel shows
 * until it has; an older file without the field loads as not paired).
 *
 * The file holds the device secret, so it is written with mode 0o600, lives only in the data directory the
 * caller passes in (the kit's ctx.dataDir), and neither its content nor a parse error message (which on newer
 * Node versions quotes the content) is ever logged. A save writes a temporary file next to it and renames it
 * into place, so a power cut leaves the old file or the new one, never half of one. Nothing here throws.
 */
import { NO_LIMITS } from '@copilot/event-engine';
import type { EngineState, OwnerLimits } from '@copilot/event-engine';
import type { FsApi } from '../platform';
import type { Log } from '../safe';

export interface PersistedState {
  v: 1; engine: EngineState; limits: OwnerLimits; popupsEnabled: boolean; asciiPopups: boolean; device: { id: string; secret: string } | null;
  /**
   * The backend has answered a request from this device as authorised (set on that answer, cleared on a 401/403).
   * Absent means false: load() gives it only when true, so files written before it existed load unchanged.
   */
  paired?: boolean;
}

/** The state file's name inside the app's data directory. */
export const STATE_FILE_NAME = 'copilot-state.json';
/** Owner read and write only: the file holds the device secret. */
export const STATE_FILE_MODE = 0o600;
/**
 * At most this many engine keys are loaded (the engine keeps one per alert key it remembers; a real car has a
 * handful). Only bounds what a damaged or foreign file can make the app hold.
 */
export const MAX_ENGINE_KEYS = 512;

const LIMIT_FIELDS: Array<keyof OwnerLimits> = ['oilTempMaxC', 'coolantTempMaxC', 'battery12vMinPercent', 'tyrePressureDeviationBar'];

/** Defaults: no limits, pop-ups on, ASCII off, no device (so not paired), empty engine memory. Fresh objects on each call. */
export function defaultState(): PersistedState {
  return { v: 1, engine: { keys: [] }, limits: { ...NO_LIMITS }, popupsEnabled: true, asciiPopups: false, device: null };
}

type Struct = Record<string, unknown>;

function isStruct(v: unknown): v is Struct {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function limitsFrom(v: unknown): OwnerLimits {
  const limits: OwnerLimits = { ...NO_LIMITS };
  if (!isStruct(v)) return limits;
  for (const field of LIMIT_FIELDS) limits[field] = finiteOrNull(v[field]);
  return limits;
}

/** The engine memory as saved; each entry is checked again by EventEngine.restore(). */
function engineFrom(v: unknown): EngineState {
  if (!isStruct(v) || !Array.isArray(v.keys)) return { keys: [] };
  return { keys: v.keys.slice(0, MAX_ENGINE_KEYS) as EngineState['keys'] };
}

function deviceFrom(v: unknown): PersistedState['device'] {
  if (!isStruct(v) || typeof v.id !== 'string' || typeof v.secret !== 'string' || v.id === '' || v.secret === '') return null;
  return { id: v.id, secret: v.secret };
}

function booleanOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** An fs error's code (ENOENT, ENOSPC, …), never its message's data. */
function codeOf(error: unknown): string {
  try {
    const code = isStruct(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error';
  } catch {
    return 'error';
  }
}

export class StateFile {
  private readonly fs: FsApi;
  private readonly log: Log;
  private readonly path: string;
  private readonly tmpPath: string;

  constructor(options: { dir: string; fs: FsApi; log: Log }) {
    this.fs = options.fs;
    this.log = options.log;
    const dir = String(options.dir || '').replace(/\/+$/, '');
    this.path = dir + '/' + STATE_FILE_NAME;
    this.tmpPath = this.path + '.tmp';
  }

  /** The saved state; missing, unreadable or of another version → defaults. A field of the wrong type → its default. */
  load(): PersistedState {
    let text: string;
    try {
      if (!this.fs.existsSync(this.path)) return defaultState();
      text = this.fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      this.warn('state file: unreadable (' + codeOf(error) + '), starting clean');
      return defaultState();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.warn('state file: not valid JSON, starting clean');   // the parse error can quote the content: not logged
      return defaultState();
    }
    if (!isStruct(raw) || raw.v !== 1) {
      this.warn('state file: unknown version, starting clean');
      return defaultState();
    }
    const defaults = defaultState();
    const loaded: PersistedState = {
      v: 1,
      engine: engineFrom(raw.engine),
      limits: limitsFrom(raw.limits),
      popupsEnabled: booleanOr(raw.popupsEnabled, defaults.popupsEnabled),
      asciiPopups: booleanOr(raw.asciiPopups, defaults.asciiPopups),
      device: deviceFrom(raw.device),
    };
    if (raw.paired === true && loaded.device !== null) loaded.paired = true;
    return loaded;
  }

  /** Writes the state to a temporary file (mode 0o600) and renames it into place. Logs a failure, never throws. */
  save(state: PersistedState): void {
    let text: string;
    try {
      text = JSON.stringify({
        v: 1,
        engine: state.engine,
        limits: state.limits,
        popupsEnabled: state.popupsEnabled,
        asciiPopups: state.asciiPopups,
        device: state.device,
        paired: state.paired === true,
      });
    } catch {
      this.warn('state file: state could not be serialised, not saved');
      return;
    }
    try {
      this.fs.writeFileSync(this.tmpPath, text, { mode: STATE_FILE_MODE });
      this.fs.renameSync(this.tmpPath, this.path);
    } catch (error) {
      this.warn('state file: save failed (' + codeOf(error) + ')');
    }
  }

  private warn(message: string): void {
    try {
      this.log.warn(message);
    } catch {
      // the log itself failed: nothing more to do without risking a throw
    }
  }
}
