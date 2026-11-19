import { z } from 'zod';
import { designTargetSchema } from '../domain/story-design';
import { materialOptionsSchema } from './request-plan';

const entity = z.enum([
  'scene',
  'chapter',
  'character',
  'location',
  'variable',
  'item',
  'shot',
  'asset',
  'choice',
  'event',
]);
export const acceptanceCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('design'),
    target: designTargetSchema,
    status: z.enum(['draft', 'confirmed', 'missing', 'review']),
  }),
  z.object({
    kind: z.literal('count'),
    entity,
    minimum: z.number().int().min(1).max(10000),
    chapterId: z.string().optional(),
  }),
  z.object({ kind: z.literal('absent'), entity, id: z.string().min(1) }),
  z.object({ kind: z.literal('exists'), entity, id: z.string().min(1) }),
  z.object({
    kind: z.literal('field'),
    entity: z.enum(['project', ...entity.options]),
    id: z.string().optional(),
    field: z
      .string()
      .max(160)
      .regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/)
      .refine(
        (value) =>
          !value.split('.').some((key) => ['constructor', 'prototype', '__proto__'].includes(key)),
      ),
    value: z.union([z.string().max(20000), z.number(), z.boolean()]),
  }),
  z.object({
    kind: z.literal('reference'),
    settingId: z.string().min(1),
    media: z.enum(['image', 'audio']),
  }),
  z.object({ kind: z.literal('routes') }),
]);

export const taskStateSchema = z.object({
  originalRequest: z.string().max(16000),
  amendments: z.array(z.string().max(16000)).max(32),
  constraints: z.array(z.string().max(800)).max(32),
  decisions: z.array(z.string().max(800)).max(32),
  blockers: z.array(z.string().max(800)).max(32),
  requirements: z.array(acceptanceCheckSchema).max(128),
  requirementHistory: z
    .array(z.object({ amendment: z.string(), checks: z.array(acceptanceCheckSchema) }))
    .max(32)
    .default([]),
  appliedAmendments: z.number().int().nonnegative().default(0),
  outcome: z.enum(['pending', 'completed', 'partial', 'blocked']),
});

const documentStepSchema = z.object({
  kind: z.literal('document'),
  stage: z.enum(['brief', 'outline', 'chapter']),
  ordinal: z.number().int().positive().optional(),
  chapterId: z.string().min(1).max(160).optional(),
  chapterCount: z.number().int().positive().optional(),
  confirm: z.boolean(),
  receipt: z.string().uuid().optional(),
});

export const projectDataToolSchema = z.enum([
  'update_project',
  'edit_world_setting',
  'edit_game_data',
]);

export const hostTaskSchema = z
  .object({
    id: z.string().uuid(),
    projectData: z
      .object({
        required: z.array(projectDataToolSchema).min(1).max(3),
        completed: z.array(projectDataToolSchema).max(3),
      })
      .optional(),
    steps: z
      .array(
        z.discriminatedUnion('kind', [
          documentStepSchema,
          z.object({
            kind: z.literal('screenplay'),
            chapterId: z.string().optional(),
            ordinal: z.number().int().positive().optional(),
            selectedIds: z.array(z.string()).max(10000).optional(),
            targetNodeIds: z.array(z.string()).max(10000).optional(),
            receipts: z.record(z.string(), z.uuid()),
            done: z.boolean(),
          }),
          z.object({
            kind: z.literal('blueprint'),
            chapterId: z.string().min(1).max(160).optional(),
            ordinal: z.number().int().positive().optional(),
            build: z.boolean(),
            production: z.boolean().optional(),
            materials: materialOptionsSchema.optional(),
            targetShotIds: z.array(z.string()).max(10000).optional(),
            originalFrames: z
              .record(
                z.string(),
                z.object({ assetId: z.string().optional(), clipId: z.string().optional() }),
              )
              .optional(),
            fromScreenplay: z.boolean().optional(),
            targetNodeIds: z.array(z.string()).max(10000).optional(),
            screenplayReads: z
              .record(
                z.string(),
                z.object({
                  version: z.uuid(),
                  through: z.number().int().nonnegative(),
                  pending: z
                    .array(
                      z.object({
                        start: z.number().int().nonnegative(),
                        end: z.number().int().positive(),
                      }),
                    )
                    .max(100)
                    .optional(),
                }),
              )
              .optional(),
            deferProduction: z.boolean().optional(),
            productionWrites: z
              .object({
                shots: z.array(z.string()).max(10000),
                text: z.array(z.string()).max(10000),
              })
              .optional(),
            minimumNewNodes: z.number().int().positive().optional(),
            preview: z.boolean().optional(),
            nodeIds: z.array(z.string()).max(10000).optional(),
            initialNodeIds: z.array(z.string()).max(10000),
            changedNodeIds: z.array(z.string()).max(10000),
            writes: z.number().int().nonnegative(),
            done: z.boolean(),
          }),
        ]),
      )
      .max(10000),
  })
  .refine((task) => task.steps.length > 0 || Boolean(task.projectData));
export type HostTask = z.infer<typeof hostTaskSchema>;
export type HostTaskStep = HostTask['steps'][number];
