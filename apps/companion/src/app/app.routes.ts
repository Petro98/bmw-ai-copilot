import { Routes } from '@angular/router';
import { pairingFragmentGuard } from './features/pair/pair.page';

/** Route data read by the shell: the heading of the top bar. */
export interface ScreenData { heading: string }

/** The three sections of the bottom navigation, then the sign-in and pairing pages. */
export const routes: Routes = [
  {
    path: '', pathMatch: 'full', data: { heading: 'Copilot' } satisfies ScreenData,
    loadComponent: () => import('./features/assistant/assistant.page').then((m) => m.AssistantPage),
  },
  {
    path: 'car', data: { heading: 'Авто' } satisfies ScreenData,
    loadComponent: () => import('./features/car/car.page').then((m) => m.CarPage),
  },
  {
    path: 'settings', data: { heading: 'Налаштування' } satisfies ScreenData,
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  // Outside the bottom navigation: the owner's sign-in and the page the car's QR code opens.
  {
    path: 'login', data: { heading: 'Вхід' } satisfies ScreenData,
    loadComponent: () => import('./features/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'pair', data: { heading: 'Підʼєднати авто' } satisfies ScreenData,
    // Takes the device secret out of the address bar and out of the Router's URL tree before the page loads.
    canActivate: [pairingFragmentGuard],
    // Also for a fragment-only navigation: a pairing link that arrives while /pair is already shown.
    runGuardsAndResolvers: 'always',
    loadComponent: () => import('./features/pair/pair.page').then((m) => m.PairPage),
  },
  { path: '**', redirectTo: '' },
];
