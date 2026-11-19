import { z } from 'zod';
import type { Asset } from './schema';

export const productionAudioRequestSchema = z.strictObject({
  category: z.literal('music'),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(2400),
  durationMs: z.number().int().min(100).max(30_000),
});
export type ProductionAudioRequest = z.infer<typeof productionAudioRequestSchema>;
export type GenerateProductionAudio = (
  projectId: string,
  productionAudio: ProductionAudioRequest,
  signal: AbortSignal,
  operationId: string,
) => Promise<Asset>;
