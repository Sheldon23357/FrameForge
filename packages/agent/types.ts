import { z } from 'zod';
import { requestPlanSchema } from './request-plan';
import { acceptanceCheckSchema, hostTaskSchema, taskStateSchema } from './task-state';
import { creativeInputSchema } from './creative-options';
import { projectChangesSchema } from '../domain/project-versions';
import { providerIdSchema } from './settings';
import {
  legacyProjectSchema,
  legacySceneSchema,
  assetSchema,
  type Project,
} from '../domain/schema';
import { skillIdentitySchema, type SkillRun } from './skills';
import { creativeDraftSchema, creativePolicySchema, type CreativeDraft } from './creative-state';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ToolReply {
  call: ToolCall;
  result: ToolResult;
}
export interface ModelFrame {
  text: string;
  calls: ToolCall[];
  // Opaque provider output, preserved inside a tool cycle, never shown as reasoning in the UI.
  raw: unknown;
  finish: 'complete' | 'length' | 'invalid';
  issue?: string;
  usage?: { input: number; output: number };
}
export interface ModelExchange {
  frame: ModelFrame;
  replies: ToolReply[];
  feedback?: string;
}
export const modelExchangeLimit = 40;
export const agentToolCallLimit = 256;
export const agentRunTimeoutMs = 20 * 60_000;
export const agentMaxOutputTokens = 40_960;
export const agentReplyCharacterLimit = 240_000;
export const modelMessageCharacterLimit = 130_000;
export const modelRequestSchema = z.object({
  runId: z.string().min(1).max(160),
  provider: providerIdSchema,
  purpose: z.literal('request_plan').optional(),
  taskStep: z.string().max(160).optional(),
  system: z.string().max(100000),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(modelMessageCharacterLimit),
      }),
    )
    .max(100),
  tools: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        description: z.string().max(4000),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
  exchanges: z.array(z.unknown()).max(modelExchangeLimit),
  maxOutputTokens: z
    .number()
    .int()
    .min(256)
    .max(agentMaxOutputTokens)
    .default(agentMaxOutputTokens),
});
export interface ModelRequest extends Omit<z.infer<typeof modelRequestSchema>, 'exchanges'> {
  exchanges: ModelExchange[];
}
export type ModelStreamDelta = { kind: 'text' | 'thoughtSummary'; text: string };
export type ModelStreamListener = (delta: ModelStreamDelta) => void;
export type ModelClient = (
  request: ModelRequest,
  signal: AbortSignal,
  onDelta?: ModelStreamListener,
) => Promise<ModelFrame>;
export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  nodeIds?: string[];
}
export interface ToolTrace {
  id: string;
  name: string;
  label: string;
  mode: 'read' | 'write' | 'view';
  arguments: string;
  result?: ToolResult;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}
export interface ContextStats {
  estimatedTokens: number;
  budgetTokens: number;
  historyTurns: number;
  summarizedTurns: number;
  selectedSceneIds: string[];
  pinnedSceneIds: string[];
  toolCount: number;
}
const toolResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.unknown().optional(),
  nodeIds: z.array(z.string()).optional(),
});
export const taskStageSchema = z.object({
  title: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(800),
  acceptance: z.string().trim().min(1).max(600),
  transient: z.boolean().optional(),
  checks: z.array(acceptanceCheckSchema).min(1).max(16).optional(),
  writeGroups: z
    .array(z.enum(['story', 'rules', 'project']))
    .max(3)
    .optional(),
});
export type TaskStage = z.infer<typeof taskStageSchema>;
const viewIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus'), nodeId: z.string() }),
  z.object({ kind: z.literal('preview'), nodeId: z.string().optional() }),
  z.object({ kind: z.literal('diagnostics') }),
]);
// Keep retired fields in the stored baseline until its original digest has been verified.
const checkpointProjectSchema = legacyProjectSchema.extend({
  scenes: z
    .array(
      legacySceneSchema.extend({
        timeoutMs: z.number().nonnegative().optional(),
        timeoutChoiceId: z.string().optional(),
      }),
    )
    .max(10000),
});
const checkpointSchema = z.object({
  id: z.uuid().optional(),
  request: z.string().min(1).max(16000),
  creativeInput: creativeInputSchema.optional(),
  task: taskStateSchema.optional(),
  hostTask: hostTaskSchema.optional(),
  requestPlan: requestPlanSchema.optional(),
  mediaJobs: z
    .array(
      z.object({
        id: z.uuid(),
        signature: z.string(),
        status: z.enum(['pending', 'completed']),
        assets: z.array(assetSchema).optional(),
      }),
    )
    .optional(),
  creativePolicy: creativePolicySchema.optional(),
  sourceDraft: creativeDraftSchema.nullable().optional(),
  skills: z.array(skillIdentitySchema).max(128).optional(),
  baseRevision: z.number().int().nonnegative(),
  baseDigest: z.string().regex(/^[0-9a-f]{64}$/),
  baseProject: checkpointProjectSchema.optional(),
  draft: legacyProjectSchema,
  stages: z.array(taskStageSchema).max(8),
  completed: z.array(z.string().max(600)).max(8),
  selectedIds: z.array(z.string()).max(10000),
  activeChapterId: z.string().nullable(),
  intents: z.array(viewIntentSchema),
  writes: z.array(
    z.object({
      signature: z.string().regex(/^[0-9a-f]{64}$/),
      operationId: z.string().optional(),
      name: z.string().max(64),
      result: toolResultSchema,
    }),
  ),
});
export type AgentCheckpoint = z.infer<typeof checkpointSchema>;
const rollbackTaskSchema = checkpointSchema
  .omit({
    baseProject: true,
    draft: true,
    baseRevision: true,
    baseDigest: true,
  })
  .extend({ changes: projectChangesSchema, hostTask: hostTaskSchema });
export type RollbackTask = z.infer<typeof rollbackTaskSchema>;
export const traceSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  mode: z.enum(['read', 'write', 'view']),
  arguments: z.string().max(64000),
  result: toolResultSchema.optional(),
  status: z.enum(['running', 'done', 'error']),
  durationMs: z.number().optional(),
});
export const turnSchema = z.object({
  id: z.string(),
  user: z.string().max(16000),
  creativeInput: creativeInputSchema.optional(),
  assistant: z.string().max(agentReplyCharacterLimit),
  offeredRequest: z.string().max(16000).optional(),
  requestPlan: requestPlanSchema.optional(),
  createdAt: z.string(),
  status: z.enum(['running', 'completed', 'stopped', 'error', 'conflict']),
  provider: providerIdSchema,
  model: z.string(),
  traces: z.array(traceSchema).max(agentToolCallLimit),
  skills: z.array(skillIdentitySchema).max(128).optional(),
  hostTask: hostTaskSchema.optional(),
  execution: z
    .object({
      modelRequests: z.number().int().nonnegative(),
      rejectedResponses: z.number().int().nonnegative(),
      contextCompactions: z.number().int().nonnegative(),
      lastRejection: z.string().optional(),
    })
    .optional(),
  outcome: z.enum(['completed', 'partial', 'blocked']).optional(),
  remaining: z.array(z.string()).optional(),
  error: z.string().optional(),
  committed: z.boolean().default(false),
  editCount: z.number().int().nonnegative().optional(),
  changedNodeIds: z.array(z.string()).default([]),
  reverted: z.boolean().optional(),
  rollback: z
    .object({
      versionId: z.string().min(1),
      pinnedSceneIds: z.array(z.string()).max(20),
      creativeDraft: creativeDraftSchema.nullable(),
      task: rollbackTaskSchema.optional(),
    })
    .optional(),
  context: z
    .object({
      selectedSceneIds: z.array(z.string()).max(10000),
      pinnedSceneIds: z.array(z.string()).max(20),
      activeChapterId: z.string().nullable(),
      projectRevision: z.number(),
      projectDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .optional(),
});
export type AgentTurn = z.infer<typeof turnSchema>;
export const sessionSchema = z.object({
  version: z.literal(1),
  id: z
    .string()
    .regex(/^chat_[a-zA-Z0-9_-]+$/)
    .max(100),
  projectId: z.string().min(1).max(160),
  title: z.string().max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z.array(turnSchema).max(1000),
  memory: z.object({
    summary: z.string().max(12000),
    through: z.number().int().nonnegative(),
    updatedAt: z.string(),
  }),
  pinnedSceneIds: z.array(z.string()).max(20),
  // A rewound chat uses its own draft so later drafts from other chats cannot leak into it.
  creativeDraft: creativeDraftSchema.nullable().optional(),
  checkpoint: checkpointSchema.optional(),
  suspendedCheckpoints: z.array(checkpointSchema).max(16).optional(),
  rollbackJournal: z
    .object({
      turnId: z.string(),
      targetDigest: z.string().regex(/^[0-9a-f]{64}$/),
      updatedAt: z.iso.datetime(),
    })
    .optional(),
});
export type AgentSession = z.infer<typeof sessionSchema>;
export type SessionInfo = Pick<
  AgentSession,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'projectId'
>;
export interface AgentAPI {
  complete(input: ModelRequest, onDelta?: ModelStreamListener): Promise<ModelFrame>;
  cancel(runId: string): Promise<void>;
  listSessions(projectId: string): Promise<SessionInfo[]>;
  saveSession(session: AgentSession): Promise<void>;
  loadSession(projectId: string, sessionId: string): Promise<AgentSession | null>;
  deleteSession(projectId: string, sessionId: string): Promise<void>;
  loadCreativeDraft(projectId: string): Promise<CreativeDraft | null>;
  saveCreativeDraft(projectId: string, draft: CreativeDraft): Promise<void>;
}
export type ViewIntent =
  | { kind: 'focus'; nodeId: string }
  | { kind: 'preview'; nodeId?: string }
  | { kind: 'diagnostics' };
export interface ToolContext {
  project: Project;
  screenplaySourceVersion?: (nodeId: string) => string | undefined;
  readPageCharacters?: number;
  reuseBatchRead?: (name: string, args: Record<string, unknown>, result: ToolResult) => ToolResult;
  saveTask?: () => Promise<void>;
  setCreativeScope?: (intent: import('./intent').CreativeIntent) => Promise<void>;
  mediaJobs?: {
    id: string;
    signature: string;
    status: 'pending' | 'completed';
    assets?: import('../domain/schema').Asset[];
  }[];
  replayMediaActions?: ReadonlySet<import('./media-jobs').MediaAction>;
  creativeDraft?: CreativeDraft;
  designConfirmations?: readonly {
    target: import('../domain/story-design').DesignTarget;
    text: string;
  }[];
  media?: {
    imageProvider?: import('./settings').ImageProvider;
    generateReference?: import('../domain/world-settings').GenerateWorldReference;
    generateShotImage?: import('../domain/production-shots').GenerateShotImage;
    generateProductionAudio?: import('../domain/production-audio').GenerateProductionAudio;
    importAssets?: (
      category?: import('../domain/assets').AudioAssetCategory,
      operationId?: string,
    ) => Promise<import('../domain/schema').Asset[]>;
  };
  signal?: AbortSignal;
  skills?: SkillRun;
  versions?: readonly import('../domain/project-versions').VersionInfo[];
  projectAtVersion?: (id: string) => Project;
  selectedIds: string[];
  activeChapterId: string | null;
  intents: ViewIntent[];
  history?: AgentTurn[];
  currentTurn?: AgentTurn;
}
export function newSession(projectId: string): AgentSession {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `chat_${crypto.randomUUID()}`,
    projectId,
    title: '新的对话',
    createdAt: now,
    updatedAt: now,
    turns: [],
    memory: { summary: '', through: 0, updatedAt: now },
    pinnedSceneIds: [],
  };
}
