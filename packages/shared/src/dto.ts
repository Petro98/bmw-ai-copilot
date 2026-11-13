import type { ScenarioId, VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent, OwnerLimits } from '@copilot/event-engine';

export type AskStyle = 'full' | 'spoken';
export type AskSource = 'panel' | 'voice' | 'car';
export const MAX_QUESTION_CHARS = 500;

export interface AskRequest { text: string; style?: AskStyle; source?: AskSource }

export interface DialogTurn {
  id: string; at: number; question: string; answer: string;
  style: AskStyle; source: AskSource; model: string; snapshotAt: number | null;
}

export interface AskResponse { turn: DialogTurn }

export type ApiErrorCode =
  | 'validation' | 'budget-exhausted' | 'rate-limited' | 'claude-unavailable'
  | 'claude-refused' | 'not-found' | 'internal' | 'unauthorized';

export interface ApiError { error: { code: ApiErrorCode; message: string } }   // message: Ukrainian, safe to display

export interface StatusDto {
  version: string;
  vehicle: { source: 'mock' | 'car'; connected: boolean; lastSnapshotAt: number | null; scenario: ScenarioId | null };
  claude: { mode: 'live' | 'mock'; model: string; voiceModel: string };
  budget: { dayUsd: number; dayLimitUsd: number; monthUsd: number; monthLimitUsd: number };
}

export interface SettingsDto { ownerLimits: OwnerLimits; popupsEnabled: boolean; diagnosticsEnabled: boolean }

export interface ScenarioDto { id: ScenarioId; title: string }

export interface MetricsDto { rssMb: number; heapUsedMb: number; cpuUserMs: number; cpuSystemMs: number; uptimeS: number; sseClients: number }

export type LiveEvent =
  | { type: 'snapshot'; snapshot: VehicleSnapshot }
  | { type: 'alert'; alert: AlertEvent }
  | { type: 'status'; status: StatusDto };

export type AskStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'sentence'; text: string }        // emitted by Plan 3; Plan 1 never sends it
  | { type: 'done'; turn: DialogTurn }
  | { type: 'error'; error: ApiError['error'] };
