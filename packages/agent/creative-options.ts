import { z } from 'zod';
import { skillNameSchema } from './skills';
import { creativeOptionsSchema, type CreativeDefaults } from '../domain/creative-options';

export const creativeInputSchema = z.strictObject({
  options: creativeOptionsSchema.optional(),
  skills: z.array(skillNameSchema).max(3).optional(),
});
export type CreativeInput = z.infer<typeof creativeInputSchema>;

export function resolveCreativeInput(defaults?: CreativeDefaults, input?: CreativeInput) {
  if (!defaults) return input;
  const overrides = Object.fromEntries(
    Object.entries(input?.options ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...input, options: { ...defaults, ...overrides } };
}
