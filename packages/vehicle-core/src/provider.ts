import { SnapshotKey, VehicleSnapshot } from './snapshot';

/** Which readings this vehicle actually delivers, and whether diagnostic reads are switched on. */
export interface VehicleCapabilities { readonly delivers: ReadonlyArray<SnapshotKey>; readonly diagnosticsEnabled: boolean }

/** A read-only source of vehicle snapshots. No provider ever writes to the vehicle. */
export interface VehicleDataProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): VehicleSnapshot;
  onChange(listener: (snapshot: VehicleSnapshot) => void): () => void;   // returns unsubscribe
  capabilities(): VehicleCapabilities;
}
