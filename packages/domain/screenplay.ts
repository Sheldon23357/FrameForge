import { z } from 'zod';
import type { Project } from './schema';

const text = z.string().trim().min(1).max(2000);
export const screenplayBlocks = z
  .array(
    z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('action'), text }),
      z.strictObject({
        kind: z.literal('dialogue'),
        speaker: z.string().trim().min(1).max(120),
        text,
      }),
      z.strictObject({
        kind: z.literal('monologue'),
        speaker: z.string().trim().min(1).max(120),
        text,
      }),
      z.strictObject({ kind: z.literal('sound'), text }),
    ]),
  )
  .min(1)
  .max(100)
  .refine(
    (blocks) => blocks.reduce((length, block) => length + block.text.length, 0) <= 16000,
    '单个节点的正文最多 16000 个字符。',
  );

export const screenplayEntry = z.object({
  id: z.string().min(1).max(160),
  version: z.uuid(),
  blocks: screenplayBlocks,
});

export type ScreenplayBlock = z.infer<typeof screenplayBlocks>[number];

export const screenplayKinds = {
  action: '动作',
  dialogue: '对白',
  monologue: '独白',
  sound: '声音',
};

export function updateScreenplay(project: Project, nodeId: string, blocks: ScreenplayBlock[]) {
  if (!project.scenes.some(({ id, kind }) => id === nodeId && kind === 'video'))
    throw new Error('剧本正文需要关联有效的演出节点。');
  const content = screenplayBlocks.parse(blocks);
  const entries = (project.screenplays ??= []);
  const index = entries.findIndex(({ id }) => id === nodeId);
  const previous = entries[index];
  if (previous && JSON.stringify(previous.blocks) === JSON.stringify(content)) return previous;
  const entry = { id: nodeId, version: crypto.randomUUID(), blocks: content };
  if (index < 0) entries.push(entry);
  else entries[index] = entry;
  return entry;
}

export function removeScreenplays(project: Project, nodeIds: readonly string[]) {
  if (!project.screenplays) return;
  project.screenplays = project.screenplays.filter(({ id }) => !nodeIds.includes(id));
  if (!project.screenplays.length) delete project.screenplays;
}

export function screenplayNeedsReview(project: Project, nodeId: string, version: string) {
  const scene = project.scenes.find(({ id }) => id === nodeId);
  return Boolean(
    (scene?.storyboardPages?.length && scene.storyboardScreenplayVersion !== version) ||
    project.productionShots?.some(
      (shot) => shot.nodeId === nodeId && shot.screenplayVersion !== version,
    ),
  );
}
