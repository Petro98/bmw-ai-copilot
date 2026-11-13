import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AlertEvent } from '@copilot/event-engine';
import type { DialogTurn, ScenarioDto, SettingsDto, StatusDto } from '@copilot/shared';
import type { ScenarioId, VehicleSnapshot } from '@copilot/vehicle-core';

/** The backend REST API (HTTP contract of Plan 1 Task 1). Nothing here reaches the vehicle: the only writes are the owner's settings and the mock scenario. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  status(): Observable<StatusDto> {
    return this.http.get<StatusDto>('/api/status');
  }

  snapshot(): Observable<VehicleSnapshot> {
    return this.http.get<VehicleSnapshot>('/api/snapshot');
  }

  /** Newest first. */
  alerts(limit = 50): Observable<AlertEvent[]> {
    return this.http.get<AlertEvent[]>('/api/alerts', { params: { limit } });
  }

  /** Newest first. */
  dialog(limit = 20): Observable<DialogTurn[]> {
    return this.http.get<DialogTurn[]>('/api/dialog', { params: { limit } });
  }

  settings(): Observable<SettingsDto> {
    return this.http.get<SettingsDto>('/api/settings');
  }

  saveSettings(settings: SettingsDto): Observable<SettingsDto> {
    return this.http.put<SettingsDto>('/api/settings', settings);
  }

  /** Only answers while the vehicle source is `mock` (404 otherwise). */
  scenarios(): Observable<ScenarioDto[]> {
    return this.http.get<ScenarioDto[]>('/api/mock/scenarios');
  }

  setScenario(id: ScenarioId): Observable<{ id: ScenarioId }> {
    return this.http.post<{ id: ScenarioId }>('/api/mock/scenario', { id });
  }
}
