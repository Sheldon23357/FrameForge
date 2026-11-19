import { z } from 'zod';

export const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const skillIdentitySchema = z.object({
  name: skillNameSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SkillIdentity = z.infer<typeof skillIdentitySchema>;
export interface SkillInfo extends SkillIdentity {
  description: string;
}
export interface SkillCatalog {
  root: string;
  skills: (SkillInfo & { directory: string })[];
  issues: string[];
}

const paging = { offset: z.number().int().min(0).max(1_000_000).default(0) };
const query = z.string().trim().max(100).default('');
export const skillReadSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('search'), query, ...paging }),
  z.strictObject({ action: z.literal('open'), name: skillNameSchema, ...paging }),
  z.strictObject({ action: z.literal('list_files'), name: skillNameSchema, query, ...paging }),
  z.strictObject({
    action: z.literal('read_file'),
    name: skillNameSchema,
    file: z.string().min(1).max(300),
    ...paging,
  }),
]);
export type SkillRead = z.infer<typeof skillReadSchema>;
export interface SkillReadResult {
  items?: (SkillInfo | string)[];
  text?: string;
  identity?: SkillIdentity;
  file?: string;
  total: number;
  nextOffset: number | null;
  truncated: boolean;
}

export interface SkillRun {
  catalog: SkillInfo[];
  read(input: SkillRead): Promise<SkillReadResult>;
}

export interface AgentSkillsAPI {
  refresh(): Promise<SkillCatalog>;
  chooseRoot(): Promise<SkillCatalog | null>;
  openRoot(): Promise<void>;
  preview(input: Extract<SkillRead, { action: 'open' }>): Promise<SkillReadResult>;
  begin(runId: string): Promise<SkillInfo[]>;
  read(runId: string, input: SkillRead): Promise<SkillReadResult>;
}
