import { z } from 'zod';
import { MAX_QUESTION_CHARS, type AskRequest, type SettingsDto } from '@copilot/shared';
import { SCENARIOS, type ScenarioId } from '@copilot/vehicle-core';
import { HttpError } from './errors';

/** `limit` of the list routes: 1–50 (the panel asks the dialog for 21). */
export const MAX_LIST_LIMIT = 50;

// Ukrainian, sentence case (docs/design/README.md → Content). Shown to the owner as they are.
const MESSAGES = {
  emptyQuestion: 'Введіть питання.',
  longQuestion: `Питання задовге: не більше ${MAX_QUESTION_CHARS} символів.`,
  badQuestion: 'Некоректне питання.',
  badLimit: `Параметр limit має бути цілим числом від 1 до ${MAX_LIST_LIMIT}.`,
  badSettings: 'Некоректні налаштування. Ліміт має бути порожнім або числом у допустимих межах.',
  badScenario: 'Невідомий сценарій.',
} as const;

export const askRequestSchema = z.object({
  text: z.string({ error: MESSAGES.badQuestion }).trim()
    .min(1, { error: MESSAGES.emptyQuestion })
    .max(MAX_QUESTION_CHARS, { error: MESSAGES.longQuestion }),
  style: z.enum(['full', 'spoken']).optional(),
  source: z.enum(['panel', 'voice', 'car']).optional(),
});

/** An owner limit: null (rule inert) or a finite number inside the given range (Plan 1 Task 13). */
function limit(min: number, max: number) {
  return z.number().min(min).max(max).nullable();
}

export const settingsSchema = z.object({
  ownerLimits: z.object({
    oilTempMaxC: limit(40, 200),
    coolantTempMaxC: limit(40, 200),
    battery12vMinPercent: limit(1, 100),
    tyrePressureDeviationBar: limit(0.05, 2),
  }),
  popupsEnabled: z.boolean(),
  // Diagnostic reads stay off until the owner approves the check in the car (Plan 1 Task 13; the panel's switch is
  // disabled with «Вимкнено, доки ви не погодите перевірку в авто»): the API cannot turn them on either.
  diagnosticsEnabled: z.literal(false),
});

const SCENARIO_IDS = SCENARIOS.map((s) => s.id);

export const scenarioRequestSchema = z.object({
  id: z.string().refine((id) => (SCENARIO_IDS as string[]).includes(id)).transform((id) => id as ScenarioId),
});

export const listQuerySchema = z.object({
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(MAX_LIST_LIMIT)).optional(),
});

/** Validated question; a failure is a 400 `validation` with the first problem's Ukrainian message. */
export function parseAskRequest(body: unknown): AskRequest {
  const result = askRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const known = issue && issue.path[0] === 'text' && Object.values(MESSAGES).includes(issue.message as never);
    throw new HttpError('validation', known ? issue.message : MESSAGES.badQuestion);
  }
  return result.data;
}

export function parseSettings(body: unknown): SettingsDto {
  const result = settingsSchema.safeParse(body);
  if (!result.success) throw new HttpError('validation', MESSAGES.badSettings);
  return result.data;
}

export function parseScenarioRequest(body: unknown): { id: ScenarioId } {
  const result = scenarioRequestSchema.safeParse(body);
  if (!result.success) throw new HttpError('validation', MESSAGES.badScenario);
  return result.data;
}

/** The `limit` query parameter, or `fallback` when it is absent. */
export function parseLimit(query: unknown, fallback: number): number {
  const result = listQuerySchema.safeParse(query ?? {});
  if (!result.success) throw new HttpError('validation', MESSAGES.badLimit);
  return result.data.limit ?? fallback;
}
