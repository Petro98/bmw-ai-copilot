import { Component, OnInit, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { LiveService } from './core/live.service';

const DEFAULT_HEADING = 'Copilot';

/** The phone shell: top bar with the screen heading and status marks, the routed screen, bottom navigation. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private readonly live = inject(LiveService);
  private readonly router = inject(Router);

  /** The car link is up when the stream is open and the backend reports its vehicle source connected. */
  protected readonly vehicleOk = computed(() => this.live.connected() && this.live.status()?.vehicle.connected === true);
  /** Claude counts as connected only in live mode; the mock mode is shown with a dash. */
  protected readonly claudeOk = computed(() => this.live.connected() && this.live.status()?.claude.mode === 'live');

  protected readonly heading = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => headingOf(this.router.routerState.snapshot.root)),
    ),
    { initialValue: DEFAULT_HEADING },
  );

  ngOnInit(): void {
    this.live.connect();
  }
}

function headingOf(route: ActivatedRouteSnapshot): string {
  let heading = DEFAULT_HEADING;
  for (let r: ActivatedRouteSnapshot | null = route; r; r = r.firstChild) {
    const value: unknown = r.data['heading'];
    if (typeof value === 'string') heading = value;
  }
  return heading;
}
