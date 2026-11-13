import { Routes } from '@angular/router';

/** Route data read by the shell: the heading of the top bar. */
export interface ScreenData { heading: string }

/** The three sections of the bottom navigation. */
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
  { path: '**', redirectTo: '' },
];
