// The car link: what the head-unit app and the backend exchange, and device registration from the panel.
import type { VehicleSnapshot } from '@copilot/vehicle-core';
import type { AlertEvent } from '@copilot/event-engine';
import type { AskStyle, DialogTurn } from './dto';
export const CAR_API_PREFIX = '/car/v1';
export const MAX_SNAPSHOTS_PER_BATCH = 60;
// `sentAt` is the car's own clock at the moment a batch is sent. The backend compares it with its clock on arrival
// and shifts the batch's times when the head-unit clock is wrong. Optional so an older car bundle still posts.
export interface CarSnapshotBatch { snapshots: VehicleSnapshot[]; sentAt?: number }   // POST /car/v1/snapshots → 204
export interface CarAlertBatch { alerts: AlertEvent[]; sentAt?: number }              // POST /car/v1/alerts → 204
export interface CarAskRequest { text: string; style: AskStyle }         // POST /car/v1/ask → { turn: DialogTurn }
export interface CarDialogResponse { turns: DialogTurn[] }               // GET /car/v1/dialog?after=<turn id> (waits up to 25 s)
export interface CarConfigResponse { ownerLimits: import('@copilot/event-engine').OwnerLimits; popupsEnabled: boolean }   // GET /car/v1/config
export interface DeviceRegistration { deviceId: string; secret: string; label: string }   // POST /api/devices → 201
export interface DeviceDto { deviceId: string; label: string; createdAt: number; lastSeenAt: number | null }
// Car requests carry:  Authorization: Bearer <deviceId>.<secret>
