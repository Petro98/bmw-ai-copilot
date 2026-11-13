import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, Injectable, OnInit, inject, signal } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn } from '@angular/router';
import type { Observable } from 'rxjs';
import type { DeviceDto, DeviceRegistration } from '@copilot/shared';

/** What the car's QR code carries in the address fragment: `#d=<deviceId>&s=<secret>` (car/src/ui/view-model.ts). */
export interface PairingRequest { deviceId: string; secret: string }

/** The backend's rules (Plan 2 Task 7): id 16–64 URL-safe characters, secret at least 32 printable characters. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SECRET_PATTERN = /^[\x21-\x7e]{32,256}$/;
const DEFAULT_LABEL = 'Головний блок';

// Ukrainian, sentence case, no exclamation marks (docs/design/README.md → Content).
export const PAIR_TEXT = {
  missing: 'Відскануйте QR-код на екрані авто, щоб відкрити цю сторінку з даними для підʼєднання.',
  invalid: 'Посилання для підʼєднання неповне. Відскануйте QR-код на екрані авто ще раз.',
  done: 'Авто підʼєднано.',
  failed: 'Не вдалося підʼєднати авто. Спробуйте ще раз.',
} as const;

/** The pairing data in a fragment, or null when it is incomplete or malformed. */
export function parsePairingFragment(fragment: string): PairingRequest | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(fragment.replace(/^#/, ''));
  } catch {
    return null;
  }
  const deviceId = params.get('d');
  const secret = params.get('s');
  if (deviceId === null || secret === null || !DEVICE_ID_PATTERN.test(deviceId) || !SECRET_PATTERN.test(secret)) return null;
  return { deviceId, secret };
}

/**
 * The device waiting to be registered, in memory only: it survives the detour through «Вхід» inside the app, and
 * nothing else (no storage, no signal a template binds, no log). Cleared once the device is registered.
 */
@Injectable({ providedIn: 'root' })
export class PairingDraft {
  private pending: PairingRequest | null = null;
  private rejected = false;

  keep(request: PairingRequest): void {
    this.pending = request;
    this.rejected = false;
  }

  /** A pairing address was there but malformed: nothing is pending, and the page says so once. */
  reject(): void {
    this.pending = null;
    this.rejected = true;
  }

  /** Whether the last pairing address was malformed; reading it resets it. */
  takeRejected(): boolean {
    const rejected = this.rejected;
    this.rejected = false;
    return rejected;
  }

  peek(): PairingRequest | null {
    return this.pending;
  }

  clear(): void {
    this.pending = null;
    this.rejected = false;
  }
}

/**
 * Reads a pairing fragment into the draft and takes it out of the browser's address bar (and so out of history and
 * screenshots) at once, with a raw `history.replaceState`.
 */
function takePairingFragment(fragment: string, draft: PairingDraft, document: Document): void {
  const view = document.defaultView;
  if (view && document.location) {
    view.history.replaceState(view.history.state, '', `${document.location.pathname}${document.location.search}`);
  }
  const request = parsePairingFragment(fragment);
  if (request) draft.keep(request);
  else draft.reject();
}

/**
 * `canActivate` of `/pair`: the Router must not keep the fragment either. Its URL tree would otherwise still hold
 * `#d=…&s=…`, and a failed navigation away (a lazy chunk that does not load) writes that tree back into the address
 * bar. So the fragment goes into the in-memory draft and the navigation is redirected to a bare `/pair`, replacing
 * the history entry. The raw fragment is read from the address bar when it is there: the car encodes each value with
 * encodeURIComponent, and the Router's own copy is already decoded.
 */
export const pairingFragmentGuard: CanActivateFn = (route) => {
  if (route.fragment === null) return true;
  const document = inject(DOCUMENT);
  const raw = document.location?.hash ?? '';
  takePairingFragment(raw !== '' && raw !== '#' ? raw : route.fragment, inject(PairingDraft), document);
  const router = inject(Router);
  return new RedirectCommand(router.createUrlTree(['/pair']), { replaceUrl: true });
};

/** `/api/devices`: the owner's paired head units. */
@Injectable({ providedIn: 'root' })
export class DeviceApi {
  private readonly http = inject(HttpClient);

  /** Newest pairing first. */
  list(): Observable<DeviceDto[]> {
    return this.http.get<DeviceDto[]>('/api/devices');
  }

  register(registration: DeviceRegistration): Observable<DeviceDto> {
    return this.http.post<DeviceDto>('/api/devices', registration);
  }

  remove(deviceId: string): Observable<void> {
    return this.http.delete<void>(`/api/devices/${encodeURIComponent(deviceId)}`);
  }
}

/** The server's Ukrainian `ApiError` message when there is one, otherwise the fallback. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message: unknown = (error.error as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

type PairState = 'missing' | 'invalid' | 'ready' | 'saving' | 'done';

/**
 * «Підʼєднати авто» (`/pair`), opened from the QR code on the car's screen. It reads the device id and secret from
 * the address fragment, removes the fragment from the address bar at once, shows the device id (never the secret),
 * and registers the device with the label the owner gives it. Without a session the first API call answers 401 and
 * the owner signs in first, then comes back here.
 */
@Component({
  selector: 'app-pair-page',
  templateUrl: './pair.page.html',
  styleUrl: './pair.page.css',
})
export class PairPage implements OnInit {
  private readonly api = inject(DeviceApi);
  private readonly draft = inject(PairingDraft);
  private readonly document = inject(DOCUMENT);

  protected readonly text = PAIR_TEXT;
  protected readonly defaultLabel = DEFAULT_LABEL;
  protected readonly state = signal<PairState>('missing');
  /** Only the public id is shown. */
  protected readonly deviceId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    // Through the Router, pairingFragmentGuard has already taken the fragment; this covers the page shown without it.
    const fragment = this.document.location?.hash ?? '';
    if (fragment !== '' && fragment !== '#') takePairingFragment(fragment, this.draft, this.document);
    if (this.draft.takeRejected()) {
      this.state.set('invalid');
      return;
    }
    const pending = this.draft.peek();
    if (!pending) return;
    this.deviceId.set(pending.deviceId);
    this.state.set('ready');
    // A session probe: without one it is a 401, which takes the owner to «Вхід» and back here.
    this.api.list().subscribe({ error: () => undefined });
  }

  protected register(event: Event, field: HTMLInputElement): void {
    event.preventDefault();
    const pending = this.draft.peek();
    if (!pending || this.state() !== 'ready') return;
    this.state.set('saving');
    this.error.set(null);
    this.api.register({ deviceId: pending.deviceId, secret: pending.secret, label: field.value.trim() }).subscribe({
      next: () => {
        this.draft.clear();
        this.state.set('done');
      },
      error: (error: unknown) => {
        this.state.set('ready');
        this.error.set(errorMessage(error, PAIR_TEXT.failed));
      },
    });
  }
}
