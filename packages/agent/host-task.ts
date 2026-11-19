import type { ProductionShot, Project } from '../domain/schema';
import { playerTextPlayback, stillClipsFor } from '../domain/timeline';
import { storyTargets } from '../domain/story-graph';
import { designStatus, readDesign, type DesignTarget } from '../domain/story-design';
import type { RequestPlan } from './request-plan';
import type { HostTask, HostTaskStep } from './task-state';
import type { ToolResult } from './types';
import { exploreStoryRoutes } from '../runtime/routes';

const blueprintTools = new Set([
  'edit_scene',
  'delete_scene',
  'edit_choice',
  'edit_event',
  'edit_chapter',
  'edit_game_data',
  'edit_world_setting',
  'generate_world_reference',
  'edit_production_shot',
  'generate_shot_image',
  'generate_image_batch',
  'generate_production_audio',
  'edit_timeline',
  'arrange_blueprint',
  'arrange_nodes',
]);
const productionTools = new Set(['edit_scene', 'edit_production_shot', 'edit_timeline']);
const shotImageTools = new Set(['generate_shot_image', 'generate_image_batch']);
const mediaProductionTools = new Set([
  'edit_production_shot',
  'generate_world_reference',
  'generate_shot_image',
  'generate_image_batch',
  'generate_production_audio',
  'edit_timeline',
]);

const ready = (step: HostTaskStep) =>
  step.kind === 'document' ? Boolean(step.receipt) : step.done;
export const activeStep = (task: HostTask) => task.steps.find((step) => !ready(step));

export function blueprintOutsideTask(
  step: Extract<HostTaskStep, { kind: 'blueprint' }>,
  before: Project,
  after: Project,
) {
  if (!step.nodeIds) return false;
  const selected = new Set(step.nodeIds);
  const others = (project: Project) => ({
    scenes: project.scenes
      .filter(({ id }) => !selected.has(id))
      .map((scene) => [scene, project.layout[scene.id]]),
    shots: project.productionShots?.filter(({ nodeId }) => !selected.has(nodeId)) ?? [],
  });
  return JSON.stringify(others(before)) !== JSON.stringify(others(after));
}

function requestedChapters(
  design: NonNullable<RequestPlan['design']>,
  project: Project,
  activeChapterId: string | null,
) {
  const selection = design.chapters ?? { kind: 'active' };
  const active = project.chapters.findIndex(({ id }) => id === activeChapterId) + 1;
  switch (selection.kind) {
    case 'ordinals':
      return [...new Set(selection.values)].sort((left, right) => left - right);
    case 'range': {
      const outline = readDesign(project, { stage: 'outline' })?.text ?? '';
      const through =
        selection.through ??
        Math.max(selection.from, project.chapters.length, outlineChapterOrder(outline).length);
      return Array.from({ length: through - selection.from + 1 }, (_, i) => selection.from + i);
    }
    case 'active':
      if (active) return [active];
    // Without an active chapter the existing chapter list is the default.
    case 'project':
      return project.chapters.map((_chapter, index) => index + 1);
  }
}

export function hostTaskFor(
  plan: RequestPlan,
  project: Project,
  activeChapterId: string | null,
  selectedIds: readonly string[],
): HostTask | undefined {
  if (plan.kind !== 'execute' && plan.kind !== 'amend') return;
  const { design, blueprint, screenplay, production, materials, canConfirm } = plan;
  const steps: HostTaskStep[] = [];
  const required: NonNullable<HostTask['projectData']>['required'] = [];
  if (design) {
    if (design.canEditSettings) required.push('update_project');
    if (design.canEditWorld) required.push('edit_world_setting');
    if (design.canEditGameData) required.push('edit_game_data');
    if (design.brief) steps.push({ kind: 'document', stage: 'brief', confirm: canConfirm });
    if (design.outline) {
      steps.push({
        kind: 'document',
        stage: 'outline',
        confirm: canConfirm,
        chapterCount: design.outlineChapterCount,
      });
    }
    if (design.chapter) {
      for (const ordinal of requestedChapters(design, project, activeChapterId)) {
        steps.push({
          kind: 'document',
          stage: 'chapter',
          ordinal,
          chapterId: project.chapters[ordinal - 1]?.id,
          confirm: canConfirm,
        });
      }
    }
  }
  const addBlueprintStep = (
    target: Pick<NonNullable<RequestPlan['blueprint']>, 'ordinal' | 'scope'>,
    options: Pick<
      Extract<HostTaskStep, { kind: 'blueprint' }>,
      | 'build'
      | 'preview'
      | 'minimumNewNodes'
      | 'production'
      | 'deferProduction'
      | 'fromScreenplay'
      | 'materials'
    >,
  ) => {
    const { ordinal, scope } = target;
    const chapterId = ordinal
      ? project.chapters[ordinal - 1]?.id
      : scope === 'active'
        ? (activeChapterId ?? undefined)
        : undefined;
    steps.push({
      kind: 'blueprint',
      ...options,
      ordinal,
      chapterId,
      nodeIds: scope === 'selected' ? [...selectedIds] : undefined,
      initialNodeIds: project.scenes
        .filter((node) => !chapterId || node.chapterId === chapterId)
        .map(({ id }) => id),
      changedNodeIds: [],
      writes: 0,
      done: false,
    });
  };
  if (blueprint) {
    const { build, preview, minimumNewNodes } = blueprint;
    addBlueprintStep(blueprint, {
      build,
      preview,
      minimumNewNodes,
      deferProduction: Boolean(screenplay || production),
    });
  }
  const screenplayScope =
    screenplay ?? (blueprint && production?.fromScreenplay ? production : undefined);
  if (screenplayScope) {
    const { ordinal, scope } = screenplayScope;
    steps.push({
      kind: 'screenplay',
      ordinal,
      chapterId: ordinal
        ? project.chapters[ordinal - 1]?.id
        : scope === 'active'
          ? (activeChapterId ?? undefined)
          : undefined,
      selectedIds: scope === 'selected' ? [...selectedIds] : undefined,
      receipts: {},
      done: false,
    });
  }
  if (production) {
    const chapterId = production.ordinal
      ? project.chapters[production.ordinal - 1]?.id
      : production.scope === 'active'
        ? activeChapterId
        : undefined;
    const screenplays = new Set(project.screenplays?.map(({ id }) => id));
    const hasScreenplay = project.scenes.some(
      (node) =>
        screenplays.has(node.id) &&
        (!production.ordinal || chapterId) &&
        (!chapterId || node.chapterId === chapterId) &&
        (production.scope !== 'selected' || selectedIds.includes(node.id)),
    );
    addBlueprintStep(production, {
      build: false,
      production: true,
      fromScreenplay: Boolean(screenplayScope || production.fromScreenplay || hasScreenplay),
    });
  }
  if (materials) {
    const { scope, ordinal, ...options } = materials;
    addBlueprintStep({ scope, ordinal }, { build: false, materials: options });
  }
  if (steps.length > 10000 || (!steps.length && !required.length)) return;
  return {
    id: crypto.randomUUID(),
    steps,
    ...(required.length && { projectData: { required, completed: [] } }),
  };
}

export function pendingProjectData(task: HostTask) {
  return (
    task.projectData?.required.filter((name) => !task.projectData?.completed.includes(name)) ?? []
  );
}

export function prepareTaskStep(task: HostTask, project: Project) {
  const step = activeStep(task);
  if (step?.kind === 'blueprint' && step.ordinal && !step.chapterId) {
    step.chapterId = project.chapters[step.ordinal - 1]?.id;
    if (step.chapterId)
      step.initialNodeIds = project.scenes
        .filter(({ chapterId }) => chapterId === step.chapterId)
        .map(({ id }) => id);
  }
  if (
    step?.kind === 'screenplay' ||
    (step?.kind === 'blueprint' && step.production && step.fromScreenplay)
  ) {
    if (step.ordinal && !step.chapterId) step.chapterId = project.chapters[step.ordinal - 1]?.id;
    const selected = step.kind === 'screenplay' ? step.selectedIds : step.nodeIds;
    step.targetNodeIds ??= project.scenes
      .filter(
        (node) =>
          node.kind === 'video' &&
          (!step.ordinal || step.chapterId) &&
          (!step.chapterId || node.chapterId === step.chapterId) &&
          (!selected || selected.includes(node.id)),
      )
      .map(({ id }) => id);
  }
  if (step?.kind === 'blueprint' && step.materials && !step.targetShotIds) {
    const nodes = new Set(
      project.scenes
        .filter(
          ({ id, kind, chapterId }) =>
            kind === 'video' &&
            (!step.ordinal || step.chapterId) &&
            (!step.chapterId || chapterId === step.chapterId) &&
            (!step.nodeIds || step.nodeIds.includes(id)),
        )
        .map(({ id }) => id),
    );
    const requested = step.materials.shotIds && new Set(step.materials.shotIds);
    step.targetShotIds = (project.productionShots ?? [])
      .filter(({ id, nodeId }) => nodes.has(nodeId) && (!requested || requested.has(id)))
      .map(({ id }) => id);
  }
  if (step?.kind === 'blueprint' && step.materials?.replace && !step.originalFrames) {
    const targets = new Set(step.targetShotIds);
    const nodes = new Map(project.scenes.map((node) => [node.id, node]));
    const usedClips = new Map<string, Set<string>>();
    step.originalFrames = {};
    for (const { id, nodeId, firstFrameAssetId } of project.productionShots ?? []) {
      const node = nodes.get(nodeId);
      if (!node || !firstFrameAssetId) continue;
      let used = usedClips.get(nodeId);
      if (!used) usedClips.set(nodeId, (used = new Set()));
      const clip =
        step.materials.timeline &&
        stillClipsFor(project, node).find(
          ({ id, assetId }) => assetId === firstFrameAssetId && !used.has(id),
        );
      if (clip) used.add(clip.id);
      if (targets.has(id))
        step.originalFrames[id] = {
          assetId: firstFrameAssetId,
          clipId: clip ? clip.id : undefined,
        };
    }
  }
  return step;
}

export function revalidateTaskReceipts(task: HostTask, project: Project) {
  for (const step of task.steps) {
    if (step.kind === 'screenplay') {
      for (const [id, version] of Object.entries(step.receipts))
        if (project.screenplays?.find((entry) => entry.id === id)?.version !== version)
          throw new Error('节点剧本正文与检查点版本不一致，已保留草稿。');
    }
    if (step.kind !== 'document' || !step.receipt) continue;
    const target = targetFor(step);
    if (
      !target ||
      readDesign(project, target)?.version !== step.receipt ||
      designStatus(project, target) !== (step.confirm ? 'confirmed' : 'draft')
    ) {
      throw new Error('已完成文档与检查点版本不一致，已保留草稿。');
    }
  }
}

export function recordScreenplayRead(
  step: Extract<HostTaskStep, { kind: 'blueprint' }>,
  project: Project,
  query: Record<string, unknown>,
  data: Record<string, unknown>,
) {
  const { nodeId, version, blocks, total } = data;
  if (
    query.action !== 'node' ||
    typeof nodeId !== 'string' ||
    query.nodeId !== nodeId ||
    !step.targetNodeIds?.includes(nodeId) ||
    !Array.isArray(blocks) ||
    !blocks.length
  )
    return;
  const entry = project.screenplays?.find(({ id }) => id === nodeId);
  if (!entry || version !== entry.version || total !== entry.blocks.length) return;

  const start = Number(query.offset ?? 0);
  const end = start + blocks.length;
  if (!Number.isSafeInteger(start) || start < 0 || end > entry.blocks.length) return;

  const saved = step.screenplayReads?.[nodeId];
  const current = saved?.version === entry.version ? saved : undefined;
  let through = current?.through ?? 0;
  if (end <= through) return;
  const pending: { start: number; end: number }[] = [];
  for (const range of [...(current?.pending ?? []), { start, end }].sort(
    (a, b) => a.start - b.start,
  )) {
    if (range.start <= through) {
      through = Math.max(through, range.end);
    } else {
      const last = pending.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else pending.push({ ...range });
    }
  }
  step.screenplayReads = {
    ...step.screenplayReads,
    [nodeId]: { version: entry.version, through, ...(pending.length ? { pending } : {}) },
  };
}

function chapterNumberValue(value: string) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  const digit = (text: string) => (text === '两' ? 2 : text === '〇' ? 0 : digits.indexOf(text));
  const [tens, units] = value.split('十');
  return units === undefined
    ? digit(value)
    : (tens ? digit(tens) : 1) * 10 + (units ? digit(units) : 0);
}

function outlineChapterOrder(text: string) {
  return [
    ...text.matchAll(
      /^[ \t]*(?:#{1,6}[ \t]+|\|[ \t]*|[-*][ \t]+)?(?:\*\*)?第\s*([一二三四五六七八九十两\d]+)\s*[章集](?=\s|[：:·、—《|*]|$)/gmu,
    ),
  ].map((match) => chapterNumberValue(match[1]));
}

function targetFor(step: Extract<HostTaskStep, { kind: 'document' }>): DesignTarget | undefined {
  if (step.stage !== 'chapter') return { stage: step.stage };
  if (step.chapterId) return { stage: 'chapter', chapterId: step.chapterId };
}

export function allowsTaskTool(step: HostTaskStep, name: string) {
  if (step.kind === 'screenplay') return name === 'edit_screenplay';
  if (step.kind === 'document')
    return (
      name === 'edit_story_design' ||
      (step.stage === 'chapter' && !step.confirm && name === 'edit_chapter')
    );
  if (step.production) return productionTools.has(name);
  if (step.materials) {
    return (
      (step.materials.generate && (shotImageTools.has(name) || name === 'edit_production_shot')) ||
      (step.materials.timeline && name === 'edit_timeline') ||
      (step.materials.overlay && name === 'edit_scene')
    );
  }
  if (step.deferProduction && mediaProductionTools.has(name)) return false;
  return blueprintTools.has(name) || (name === 'open_story_view' && Boolean(step.preview));
}

function sceneEditOperations(query: Record<string, unknown>) {
  const batch = query.args as { operations?: unknown[] } | undefined;
  const entries = query.action === 'batch' ? (batch?.operations ?? []) : [query];
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const operation = entry as Record<string, unknown>;
    const fields = (operation.args ?? operation) as Record<string, unknown>;
    if (typeof fields.nodeId !== 'string' || !fields.patch || typeof fields.patch !== 'object')
      return;
    return { action: operation.action, nodeId: fields.nodeId, patch: fields.patch };
  });
}

export function taskWriteError(
  step: HostTaskStep,
  project: Project,
  name: string,
  query: Record<string, unknown>,
) {
  if (!allowsTaskTool(step, name)) return '该操作超出当前任务步骤的范围。';
  if (step.kind === 'screenplay')
    return step.targetNodeIds?.includes(String(query.nodeId))
      ? undefined
      : '请保存任务范围内的演出节点正文。';
  if (step.kind === 'blueprint') {
    if (step.ordinal && !step.chapterId) return `工程里还没有第 ${step.ordinal} 章。`;
    if (step.materials) return materialWriteError(step, project, name, query);
    if (step.production && name === 'edit_timeline') {
      const command = query.command as Record<string, unknown> | undefined;
      const patch = command?.patch as Record<string, unknown> | undefined;
      const node = project.scenes.find(({ id }) => id === query.nodeId);
      if (
        node?.kind !== 'video' ||
        (step.chapterId && node.chapterId !== step.chapterId) ||
        (step.nodeIds && !step.nodeIds.includes(node.id)) ||
        command?.action !== 'update_still' ||
        !patch ||
        Object.keys(patch).length !== 1 ||
        typeof patch.durationMs !== 'number' ||
        !node.timeline?.stillClips?.some(({ id }) => id === command.clipId)
      )
        return '节点制作只可用 update_still 调整任务范围内已有图片片段的 durationMs。';
    }
    if (step.production && name === 'edit_scene') {
      const operations = sceneEditOperations(query);
      if (
        !operations.length ||
        operations.some(
          (operation) =>
            operation?.action !== 'update' ||
            Object.keys(operation.patch).some(
              (key) =>
                key !== 'storyboardPages' && key !== 'storyboardOverlay' && key !== 'choicesAtMs',
            ),
        )
      )
        return '节点制作步骤通过 edit_scene 更新玩家剧情文字、叠字设置和选项出现时点。节点内容、连线与规则在蓝图步骤处理。';
      for (const operation of operations) {
        if (!operation || !('choicesAtMs' in operation.patch)) continue;
        const node = project.scenes.find(({ id }) => id === operation.nodeId);
        if (
          node?.kind !== 'video' ||
          !node.choices.length ||
          (step.chapterId && node.chapterId !== step.chapterId) ||
          (step.nodeIds && !step.nodeIds.includes(node.id))
        )
          return '只可调整任务范围内已有玩家选项的出现时点。';
      }
    }
    if (step.production && step.fromScreenplay) {
      const targetIds =
        name === 'edit_scene'
          ? sceneEditOperations(query).flatMap((operation) => (operation ? [operation.nodeId] : []))
          : [
              name === 'edit_timeline' || query.action === 'create'
                ? query.nodeId
                : project.productionShots?.find(({ id }) => id === query.shotId)?.nodeId,
            ];
      for (const id of targetIds) {
        if (typeof id !== 'string' || !step.targetNodeIds?.includes(id))
          return '该操作超出指定的分镜节点范围。';
        const entry = project.screenplays?.find((row) => row.id === id);
        if (!entry) return `节点 ${id} 缺少剧本正文，请先执行正文步骤。`;
        const read = step.screenplayReads?.[id];
        const offset = read?.version === entry.version ? read.through : 0;
        if (offset < entry.blocks.length)
          return `请先用 read_screenplay 的 node 操作读完整节点 ${id} 的当前正文，从 offset=${offset} 继续。可以直接读取或通过 read_batch 分页读取。`;
      }
    }
    if (name === 'edit_chapter') {
      const patch = query.patch as Record<string, unknown> | undefined;
      if (
        query.action !== 'update' ||
        query.designText !== undefined ||
        !patch ||
        Object.keys(patch).some((key) => key !== 'startNodeId') ||
        query.index !== undefined
      )
        return '蓝图步骤只可通过章节工具设置章起点。';
    }
    if (name === 'open_story_view') {
      const args = query.args as { nodeId?: string } | undefined;
      const nodeId = args?.nodeId ?? project.startNodeId;
      if (
        query.action !== 'preview' ||
        (step.chapterId &&
          !project.scenes.some((node) => node.id === nodeId && node.chapterId === step.chapterId))
      )
        return '请使用指定章节内的节点启动试玩。';
    }
    return;
  }
  const label = step.ordinal ? `本轮只写第 ${step.ordinal} 章。` : '该文档超出本轮指定的写作范围。';
  if (name === 'edit_chapter') {
    if (
      step.chapterId
        ? query.chapterId !== step.chapterId || query.action !== 'update'
        : query.action !== 'create'
    )
      return label;
    if (!step.chapterId && step.ordinal !== project.chapters.length + 1)
      return `工程缺少第 ${step.ordinal} 章之前的章节，无法按序创建目标章节。`;
    const patch = query.patch as Record<string, unknown> | undefined;
    if (
      typeof query.designText !== 'string' ||
      query.index !== undefined ||
      (patch && Object.keys(patch).some((key) => key !== 'title'))
    )
      return '请用 designText 保存完整章节正文。';
    return;
  }
  const target = query.target as DesignTarget;
  if (
    target.stage !== step.stage ||
    (target.stage === 'chapter' && target.chapterId !== step.chapterId)
  )
    return label;
  const confirms = query.action === 'confirm' || query.confirmed === true;
  if (step.confirm !== confirms)
    return step.confirm
      ? '本轮要求确认指定版本。'
      : '请将正文保存为草稿。确认稿件需要用户明确要求。';
  if (!confirms && (typeof query.text !== 'string' || !query.text.trim()))
    return '请写入完整正文。';
  if (step.chapterCount && typeof query.text === 'string') {
    const numbers = outlineChapterOrder(query.text);
    if (
      numbers.length !== step.chapterCount ||
      numbers.some((number, index) => number !== index + 1)
    )
      return `请保留原正文，只修正编号。大纲需依次标出 ${step.chapterCount} 章或集，标题与表格均可使用「第 1 章」或「第 1 集」。`;
  }
}

type BlueprintStep = Extract<HostTaskStep, { kind: 'blueprint' }>;

function materialWriteError(
  step: BlueprintStep,
  project: Project,
  name: string,
  query: Record<string, unknown>,
) {
  const target = (id: unknown) => step.targetShotIds?.includes(String(id));
  if (name === 'generate_shot_image') {
    if (
      !target(query.shotId) ||
      query.frame === 'last' ||
      (query.replace && !step.materials?.replace)
    )
      return '只可生成任务指定的分镜首帧，替换需要在素材任务中明确指定。';
    if (step.materials?.replace) {
      const current = project.productionShots?.find(
        ({ id }) => id === query.shotId,
      )?.firstFrameAssetId;
      if (current && current !== step.originalFrames?.[String(query.shotId)]?.assetId)
        return '此镜头已换成新的首帧，请继续处理时间线或其他镜头。';
    }
  }
  if (name === 'edit_production_shot') {
    const patch = query.patch as Record<string, unknown> | undefined;
    if (
      query.action !== 'update' ||
      !target(query.shotId) ||
      query.index !== undefined ||
      !patch ||
      Object.keys(patch).length !== 1 ||
      !patch.firstFramePrompt
    )
      return '此步骤只可补写目标镜头的首帧提示词。';
  }
  if (name === 'edit_timeline') {
    const command = query.command as Record<string, unknown> | undefined;
    const node = project.scenes.find(({ id }) => id === query.nodeId);
    const shots =
      project.productionShots?.filter(({ id, nodeId }) => target(id) && nodeId === node?.id) ?? [];
    const clips = node ? stillClipsFor(project, node) : [];
    if (step.materials?.replace && command?.action === 'update_still') {
      const patch = command.patch as Record<string, unknown> | undefined;
      if (
        patch &&
        Object.keys(patch).length === 1 &&
        shots.some((shot) => {
          const original = step.originalFrames?.[shot.id];
          return (
            original?.clipId &&
            original.clipId === command.clipId &&
            shot.firstFrameAssetId &&
            shot.firstFrameAssetId !== original.assetId &&
            patch.assetId === shot.firstFrameAssetId &&
            clips.some(
              ({ id, assetId }) =>
                id === original.clipId &&
                (assetId === original.assetId || assetId === shot.firstFrameAssetId),
            )
          );
        })
      )
        return;
      return '请只更新原图片片段的 assetId，使用对应镜头新绑定的首帧。';
    }
    if (
      command?.action === 'move' &&
      !step.materials?.replace &&
      clips.some(
        ({ id, assetId }) =>
          id === command.clipId && shots.some((shot) => shot.firstFrameAssetId === assetId),
      )
    )
      return;
    if (
      command?.action !== 'append_shot_frame' ||
      command.frame !== 'first' ||
      !target(command.shotId)
    )
      return '此步骤只可将目标镜头首帧加入图片轨。';
    if (step.materials?.replace && step.originalFrames?.[String(command.shotId)]?.clipId)
      return '该镜头已有原图片片段，请用 update_still 原位替换。';
    const assetId = shots.find(({ id }) => id === command.shotId)?.firstFrameAssetId;
    if (
      assetId &&
      clips.filter((clip) => clip.assetId === assetId).length >=
        shots.filter((shot) => shot.firstFrameAssetId === assetId).length
    )
      return '此首帧已经在时间线，请继续处理缺少的镜头。';
  }
  if (name === 'edit_scene') {
    const targets = new Set(
      project.productionShots?.filter(({ id }) => target(id)).map(({ nodeId }) => nodeId),
    );
    const operations = sceneEditOperations(query);
    if (
      !operations.length ||
      operations.some(
        (operation) =>
          operation?.action !== 'update' ||
          !targets.has(operation.nodeId) ||
          Object.keys(operation.patch).length !== 1 ||
          !('storyboardOverlay' in operation.patch) ||
          operation.patch.storyboardOverlay !== true,
      )
    )
      return '此步骤只可开启目标节点的剧情文字叠加。';
  }
}

export function materialTaskIssue(step: BlueprintStep, project: Project) {
  if (!step.materials) return;
  const { timeline, overlay, replace, shotIds } = step.materials;
  const targets = new Set(step.targetShotIds);
  const shots = (project.productionShots ?? []).filter(({ id }) => targets.has(id));
  if (!shots.length) return '素材任务范围内没有制作镜头。';
  if (shots.length !== targets.size || shotIds?.some((id) => !targets.has(id)))
    return '有指定镜头不存在或超出素材任务范围。';
  const assets = new Set(project.assets.filter(({ type }) => type === 'image').map(({ id }) => id));
  const missing = shots.filter(
    ({ firstFrameAssetId }) => !firstFrameAssetId || !assets.has(firstFrameAssetId),
  );
  if (missing.length)
    return `缺少已绑定首帧的镜头（${missing.length} 个）：${missing
      .slice(0, 15)
      .map(({ id }) => id)
      .join('、')}`;
  if (replace) {
    const unchanged = shots.filter(
      ({ id, firstFrameAssetId }) => firstFrameAssetId === step.originalFrames?.[id]?.assetId,
    );
    if (unchanged.length)
      return `仍绑定旧首帧的镜头（${unchanged.length} 个）：${unchanged
        .slice(0, 15)
        .map(({ id }) => id)
        .join('、')}`;
  }
  const nodes = new Map(project.scenes.map((node) => [node.id, node]));
  const byNode = new Map<string, ProductionShot[]>();
  for (const shot of shots) {
    const existing = byNode.get(shot.nodeId);
    if (existing) existing.push(shot);
    else byNode.set(shot.nodeId, [shot]);
  }
  const needTimeline: string[] = [];
  const needOverlay: string[] = [];
  for (const [nodeId, nodeShots] of byNode) {
    const node = nodes.get(nodeId);
    if (node?.kind !== 'video') return `素材目标节点 ${nodeId} 不存在或不是视频节点。`;
    if (timeline) {
      const clips = stillClipsFor(project, node);
      let index = -1;
      for (const shot of nodeShots) {
        const originalClip = replace ? step.originalFrames?.[shot.id]?.clipId : undefined;
        index = clips.findIndex(
          ({ id, assetId }, offset) =>
            offset > index &&
            assetId === shot.firstFrameAssetId &&
            (!originalClip || id === originalClip),
        );
        if (index === -1) {
          needTimeline.push(nodeId);
          break;
        }
      }
    }
    if (overlay && node.storyboardPages?.length && !node.storyboardOverlay)
      needOverlay.push(nodeId);
  }
  if (needTimeline.length)
    return `图片轨尚未按镜头顺序排齐的节点（${needTimeline.length} 个）：${needTimeline.slice(0, 15).join('、')}`;
  if (needOverlay.length) return `还需开启剧情文字叠加：${needOverlay.slice(0, 15).join('、')}`;
}

export function recordTaskWrite(
  step: HostTaskStep,
  project: Project,
  name: string,
  result: ToolResult,
  changed: boolean,
  query?: Record<string, unknown>,
) {
  if (step.kind === 'screenplay') {
    const receipt = result.data as { nodeId: string; version: string };
    step.receipts[receipt.nodeId] = receipt.version;
    step.done =
      Boolean(step.targetNodeIds?.length) &&
      step.targetNodeIds!.every((id) => Boolean(step.receipts[id]));
    return;
  }
  if (step.kind === 'blueprint') {
    if (step.production && result.nodeIds) {
      const writes = (step.productionWrites ??= { shots: [], text: [] });
      if (name === 'edit_production_shot' && query?.action !== 'delete')
        writes.shots = [...new Set([...writes.shots, ...result.nodeIds])];
      if (name === 'edit_scene' && query) {
        const targets = new Set(
          sceneEditOperations(query).flatMap((operation) =>
            operation && 'storyboardPages' in operation.patch ? [operation.nodeId] : [],
          ),
        );
        writes.text = [
          ...new Set([...writes.text, ...result.nodeIds.filter((id) => targets.has(id))]),
        ];
      }
    }
    if (changed) {
      step.writes++;
      step.changedNodeIds = [...new Set([...step.changedNodeIds, ...(result.nodeIds ?? [])])];
    }
    return;
  }
  if (name === 'edit_chapter' && !step.chapterId)
    step.chapterId = (result.data as { id: string }).id;
  const target = targetFor(step);
  if (target && designStatus(project, target) === (step.confirm ? 'confirmed' : 'draft'))
    step.receipt = readDesign(project, target)?.version;
}

function blueprintExits(step: Extract<HostTaskStep, { kind: 'blueprint' }>, project: Project) {
  const nodes = project.scenes.filter(
    (node) => !step.chapterId || node.chapterId === step.chapterId,
  );
  const baseline = new Set(step.initialNodeIds);
  const changed = new Set(step.changedNodeIds);
  const created = nodes.filter(({ id }) => !baseline.has(id));
  const playable = nodes.filter(
    (node) =>
      changed.has(node.id) &&
      (node.kind === 'ending'
        ? Boolean(node.endingText?.trim())
        : node.kind === 'video' &&
          (node.storyboardPages?.some(({ text }) => text.trim()) ||
            node.assetId ||
            node.timeline?.videoClips.length)),
  );
  const inspected = new Set([...created, ...playable]);
  const missing = nodes.filter(
    (node) => inspected.has(node) && node.kind !== 'ending' && !node.nextId && !node.choices.length,
  );
  return { nodes, created, playable, missing };
}

function pendingChapterHandoff(
  step: Extract<HostTaskStep, { kind: 'blueprint' }>,
  project: Project,
  { nodes, missing, playable }: ReturnType<typeof blueprintExits>,
) {
  if (!step.build || step.production || step.nodeIds || !step.chapterId || missing.length !== 1)
    return;
  const [exit] = missing;
  if (exit.kind !== 'video' || !playable.includes(exit)) return;
  if (
    nodes.some(
      (node) => node !== exit && node.kind !== 'ending' && !node.nextId && !node.choices.length,
    )
  )
    return;
  const chapterIndex = project.chapters.findIndex(({ id }) => id === step.chapterId);
  if (chapterIndex < 0) return;
  const chapter = project.chapters[chapterIndex];
  const nextChapter = project.chapters[chapterIndex + 1];
  if (
    !nextChapter ||
    nextChapter.startNodeId ||
    project.scenes.some(({ chapterId }) => chapterId === nextChapter.id)
  )
    return;

  // Only a playable chapter route can hand off to an unfinished next chapter.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const pending = [chapter.startNodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    if (node === exit) return { exit, nextChapter };
    seen.add(id);
    pending.push(...storyTargets(node));
  }
}

export function blueprintExitIssue(
  step: Extract<HostTaskStep, { kind: 'blueprint' }>,
  project: Project,
) {
  if (!step.build || step.production) return;
  const exits = blueprintExits(step, project);
  if (exits.missing.length && !pendingChapterHandoff(step, project, exits))
    return `蓝图节点缺少去向：${exits.missing
      .slice(0, 5)
      .map(({ title, id }) => `「${title}」(${id})`)
      .join('、')}。请连接已有节点或将实际结局设置为结局节点。`;
}

export function blueprintPlaybackCheck(step: BlueprintStep, project: Project) {
  if ((!step.build && !step.preview) || step.production || step.materials) return;
  const chapter = project.chapters.find(({ id }) => id === step.chapterId);
  const handoff = pendingChapterHandoff(step, project, blueprintExits(step, project));
  const start = chapter ? chapter.startNodeId : project.startNodeId;
  if (!start) return { issue: '请先设置可试玩的剧情起点。', truncated: false };
  try {
    const result = exploreStoryRoutes(
      project,
      start,
      chapter && { chapterId: chapter.id, handoffId: handoff?.exit.id },
    );
    return { issue: result.failures[0], truncated: result.truncated };
  } catch (error) {
    return {
      issue: error instanceof Error ? error.message : '启动剧情路线失败。',
      truncated: false,
    };
  }
}

export function screenplayProductionIssue(step: BlueprintStep, project: Project) {
  if (!step.production || !step.fromScreenplay) return;
  if (!step.targetNodeIds?.length) return '任务范围内没有可制作的演出节点。';

  const nodes = new Map(project.scenes.map((node) => [node.id, node]));
  const versions = new Map(project.screenplays?.map(({ id, version }) => [id, version]));
  const shotsByNode = new Map<string, ProductionShot[]>();
  for (const shot of project.productionShots ?? []) {
    const shots = shotsByNode.get(shot.nodeId);
    if (shots) shots.push(shot);
    else shotsByNode.set(shot.nodeId, [shot]);
  }

  const missing: string[] = [];
  for (const id of step.targetNodeIds) {
    const node = nodes.get(id);
    const version = versions.get(id);
    if (node?.kind !== 'video' || !version) {
      missing.push(`${id} 缺少可用的演出节点或剧本正文`);
      continue;
    }
    const shots = shotsByNode.get(id) ?? [];
    const stale = shots.filter((shot) => shot.screenplayVersion !== version);
    if (!shots.length) missing.push(`${id} 缺少制作镜头`);
    if (stale.length) {
      const labels = stale.slice(0, 8).map(({ label, id }) => `${label}(${id})`);
      missing.push(`${id} 有 ${stale.length} 张分镜卡待同步：${labels.join('、')}`);
    }
    if (
      node.storyboardScreenplayVersion !== version ||
      !node.storyboardPages?.some(({ text }) => text.trim())
    )
      missing.push(`${id} 缺少与当前剧本一致的玩家剧情文字`);
  }
  if (missing.length)
    return `请按当前剧本补齐分镜和玩家文字。待处理项（${missing.length}）：${missing.slice(0, 12).join('；')}。`;
}

export function blueprintStepComplete(
  step: Extract<HostTaskStep, { kind: 'blueprint' }>,
  project: Project,
  disconnected: boolean,
  final: boolean,
) {
  if (disconnected) return false;
  if (step.materials) return !materialTaskIssue(step, project);
  if (step.production) {
    if (step.fromScreenplay) return final && !screenplayProductionIssue(step, project);
    const shotNodes = new Set(project.productionShots?.map(({ nodeId }) => nodeId));
    const shotWrites = new Set(step.productionWrites?.shots);
    const textWrites = new Set(step.productionWrites?.text);
    const touched = new Set(
      step.targetNodeIds ?? [...step.changedNodeIds, ...shotWrites, ...textWrites],
    );
    const nodes = project.scenes.filter(({ id, kind }) => kind === 'video' && touched.has(id));
    return (
      final &&
      Boolean(nodes.length) &&
      nodes.every(
        (node) =>
          shotWrites.has(node.id) &&
          textWrites.has(node.id) &&
          shotNodes.has(node.id) &&
          node.storyboardPages?.length,
      )
    );
  }
  if (!step.writes) return false;
  const exits = blueprintExits(step, project);
  if (step.minimumNewNodes && exits.created.length < step.minimumNewNodes) return false;
  if (!step.build) return final && !blueprintPlaybackCheck(step, project)?.issue;
  if (!exits.playable.length) return false;
  // With no measurable size request, the model can signal that it has finished authoring.
  // Host checks still control whether the graph can be accepted.
  return (
    (Boolean(step.minimumNewNodes) || final) &&
    (!exits.missing.length || (final && Boolean(pendingChapterHandoff(step, project, exits)))) &&
    !blueprintPlaybackCheck(step, project)?.issue
  );
}

export function taskReceipt(task: HostTask, project: Project) {
  const documents = task.steps.filter((step) => step.kind === 'document');
  const chapters = documents.filter(({ stage }) => stage === 'chapter');
  const output = documents
    .filter(({ stage }) => stage !== 'chapter')
    .map((step) =>
      step.confirm
        ? `已确认${step.stage === 'outline' ? '大纲' : '简报'}。`
        : step.chapterCount
          ? `已将大纲重排为 ${step.chapterCount} 章并保存为草稿。`
          : `已保存${step.stage === 'outline' ? '大纲' : '简报'}草稿。`,
    );
  if (task.projectData?.completed.length) {
    const labels = {
      update_project: '作品设置',
      edit_world_setting: '人物或场景设定',
      edit_game_data: '属性或道具',
    };
    output.push(
      `已核对并保存${task.projectData.completed.map((name) => labels[name]).join('、')}。`,
    );
  }
  if (chapters.length === 1)
    output.push(
      chapters[0].confirm
        ? `已确认第 ${chapters[0].ordinal} 章正文。`
        : `已保存第 ${chapters[0].ordinal} 章正文草稿。`,
    );
  if (chapters.length > 1)
    output.push(
      chapters.every(({ confirm }) => confirm)
        ? `已确认指定的 ${chapters.length} 章正文。`
        : `已保存指定的 ${chapters.length} 章正文草稿。`,
    );
  const blueprints = task.steps
    .filter((step) => step.kind === 'blueprint')
    .filter((step) => !step.production && !step.materials);
  if (blueprints.length) output.push('已保存蓝图修改，并检查节点连通性。');
  for (const step of blueprints) {
    const handoff = pendingChapterHandoff(step, project, blueprintExits(step, project));
    if (handoff)
      output.push(`「${handoff.exit.title}」的章尾出口待接入「${handoff.nextChapter.title}」。`);
    const playback = blueprintPlaybackCheck(step, project);
    if (playback)
      output.push(
        playback.truncated
          ? '已模拟已探索路线，本次达到探索上限。'
          : '已用播放器规则模拟目标范围内的可达路线。',
      );
  }
  const screenplayCount = task.steps.reduce(
    (count, step) =>
      step.kind === 'screenplay' ? count + Object.keys(step.receipts).length : count,
    0,
  );
  if (screenplayCount) output.push(`已保存 ${screenplayCount} 个节点的剧本正文。`);
  for (const step of task.steps) {
    if (step.kind !== 'blueprint') continue;
    if (step.production) {
      output.push('已保存制作分镜与玩家剧情文字。');
      const ids = new Set(step.targetNodeIds ?? step.changedNodeIds);
      const planned = new Map<string, number>();
      for (const { nodeId, durationMs } of project.productionShots ?? []) {
        if (ids.has(nodeId)) planned.set(nodeId, (planned.get(nodeId) ?? 0) + durationMs);
      }
      const short = project.scenes.filter((node) => {
        const durationMs = planned.get(node.id);
        if (!durationMs) return false;
        const { authoredDurationMs } = playerTextPlayback(project, node);
        const available = node.choices.length
          ? Math.min(node.choicesAtMs ?? durationMs, durationMs)
          : durationMs;
        return authoredDurationMs > available;
      });
      if (short.length)
        output.push(
          `${short.length} 个节点的文字页时长超过计划画面或选项前时长，出图前请复核：${short
            .slice(0, 5)
            .map(({ title }) => title)
            .join('、')}。`,
        );
    }
    if (step.materials) {
      output.push(
        `已${step.materials.replace ? '替换并核对' : '核对'} ${step.targetShotIds?.length ?? 0} 个镜头的首帧绑定${step.materials.timeline ? '与节点图片轨' : ''}。`,
      );
      if (!step.materials.timeline) continue;
      const shots = new Set(step.targetShotIds);
      const ids = new Set(
        project.productionShots?.filter(({ id }) => shots.has(id)).map(({ nodeId }) => nodeId),
      );
      const issues = project.scenes.filter((node) => {
        if (!ids.has(node.id)) return false;
        const text = playerTextPlayback(project, node);
        return text.mode === 'hidden' || text.compressed || text.choiceBeforeTextEnd;
      });
      if (issues.length)
        output.push(
          `${issues.length} 个节点的玩家文字被隐藏、压缩或在播完前出现选项，试玩前请复核：${issues
            .slice(0, 5)
            .map(({ title }) => title)
            .join('、')}。`,
        );
    }
  }
  return output.join('\n');
}

export function taskProgress(task: HostTask | undefined, project?: Project) {
  if (!task) return;
  const step = activeStep(task);
  const next =
    step?.kind === 'blueprint'
      ? {
          kind: step.kind,
          chapterId: step.chapterId,
          ordinal: step.ordinal,
          build: step.build,
          ...(step.production && { production: true }),
          ...(step.materials && {
            materials: { ...step.materials, shotIds: step.materials.shotIds?.slice(0, 30) },
            ...(project && { remaining: materialTaskIssue(step, project) }),
          }),
          ...(step.fromScreenplay && {
            fromScreenplay: true,
            targetNodeIds: step.targetNodeIds?.slice(0, 30),
            ...(project && { remaining: screenplayProductionIssue(step, project) }),
          }),
          ...(step.deferProduction && { deferProduction: true }),
          minimumNewNodes: step.minimumNewNodes,
          nodeIds: step.nodeIds?.slice(0, 30),
          writes: step.writes,
        }
      : step?.kind === 'screenplay'
        ? {
            kind: step.kind,
            chapterId: step.chapterId,
            ordinal: step.ordinal,
            remainingNodeIds: step.targetNodeIds?.filter((id) => !step.receipts[id]).slice(0, 30),
          }
        : step;
  return {
    id: task.id,
    done: task.steps.filter(ready).length + (task.projectData?.completed.length ?? 0),
    total: task.steps.length + (task.projectData?.required.length ?? 0),
    next,
    pendingProjectData: pendingProjectData(task),
  };
}
