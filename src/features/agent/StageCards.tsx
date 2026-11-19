import { useState } from 'react';
import type { AgentTurn } from '../../../packages/agent/types';
import { activeStep } from '../../../packages/agent/host-task';
import { requestPlanSchema } from '../../../packages/agent/request-plan';
import { useAgent } from '../../store/agent';
import { useEditor } from '../../store/editor';

const stages = [
  'brief',
  'outline',
  'chapter',
  'blueprint',
  'screenplay',
  'production',
  'materials',
  'preview',
] as const;
type Stage = (typeof stages)[number];
const stageLabels: Record<Stage, string> = {
  brief: '故事设定',
  outline: '全剧大纲',
  chapter: '分章节大纲',
  blueprint: '章节蓝图',
  screenplay: '章节剧本',
  production: '分镜与玩家文字',
  materials: '素材与时间线',
  preview: '试玩',
};
const nextActionLabels: Record<Exclude<Stage, 'brief'>, string> = {
  outline: '生成全剧大纲',
  chapter: '生成分章节大纲',
  blueprint: '搭建章节蓝图',
  screenplay: '编写章节剧本',
  production: '生成分镜与玩家文字',
  materials: '制作素材并编排时间线',
  preview: '启动试玩',
};

type Card = { chapterIds: Set<string>; nodeIds: Set<string>; chapterWide: boolean };

export function StageCards({ turn, busy }: { turn: AgentTurn; busy: boolean }) {
  const [notes, setNotes] = useState<Partial<Record<Stage, string>>>({});
  const [reviewChapters, setReviewChapters] = useState<Partial<Record<Stage, string>>>({});
  if (
    turn.reverted ||
    turn.status !== 'completed' ||
    (turn.outcome !== undefined && turn.outcome !== 'completed') ||
    (turn.hostTask && activeStep(turn.hostTask))
  )
    return null;
  const cards = new Map<Stage, Card>();
  const add = (
    stage: Stage,
    chapterId?: string | null,
    nodeIds: string[] = [],
    chapterWide = false,
  ) => {
    const card = cards.get(stage) ?? {
      chapterIds: new Set<string>(),
      nodeIds: new Set<string>(),
      chapterWide: false,
    };
    if (chapterId) card.chapterIds.add(chapterId);
    card.chapterWide ||= chapterWide;
    nodeIds.forEach((id) => card.nodeIds.add(id));
    cards.set(stage, card);
  };
  for (const step of turn.hostTask?.steps ?? []) {
    if (step.kind === 'document' && step.receipt) add(step.stage, step.chapterId);
    if (step.kind === 'blueprint' && step.done && (step.build || step.production))
      add(
        step.production ? 'production' : 'blueprint',
        step.chapterId,
        step.targetNodeIds ?? step.changedNodeIds,
        !step.nodeIds,
      );
    if (step.kind === 'screenplay' && step.done)
      add('screenplay', step.chapterId, Object.keys(step.receipts), !step.selectedIds);
    if (step.kind === 'blueprint' && step.done && step.materials?.timeline)
      add('materials', step.chapterId, step.nodeIds ?? step.changedNodeIds, !step.nodeIds);
  }
  if (turn.committed) {
    const writes = turn.traces.filter((trace) => trace.mode === 'write' && trace.result?.ok);
    const media = writes.filter(({ name }) =>
      [
        'generate_shot_image',
        'generate_image_batch',
        'generate_production_audio',
        'edit_timeline',
      ].includes(name),
    );
    const productionStep = turn.hostTask?.steps.some(
      (step) => step.kind === 'blueprint' && step.production,
    );
    if (media.length && !productionStep)
      add(
        'materials',
        turn.context?.activeChapterId,
        media.flatMap(({ result }) => result?.nodeIds ?? []),
      );
    if (
      !cards.has('brief') &&
      turn.requestPlan?.design &&
      (turn.requestPlan.design.brief ||
        turn.requestPlan.design.canEditSettings ||
        turn.requestPlan.design.canEditWorld) &&
      writes.some(({ name }) =>
        ['update_project', 'edit_story_design', 'edit_world_setting'].includes(name),
      )
    )
      add('brief');
    if (!cards.has('production') && writes.some(({ name }) => name === 'edit_production_shot'))
      add(
        'production',
        turn.context?.activeChapterId,
        writes
          .filter(({ name }) => name === 'edit_production_shot')
          .flatMap(({ result }) => result?.nodeIds ?? []),
      );
  }
  if (!cards.size) return null;

  const resolve = (card: Card) => {
    const project = useEditor.getState().project;
    const nodeIds = [...card.nodeIds].filter((id) => project.scenes.some((node) => node.id === id));
    const chapterIds = [
      ...new Set([
        ...card.chapterIds,
        ...project.scenes
          .filter(({ id }) => card.nodeIds.has(id))
          .map(({ chapterId }) => chapterId),
      ]),
    ];
    return {
      project,
      nodeIds,
      chapters: project.chapters.filter(({ id }) => chapterIds.includes(id)),
    };
  };
  const review = (stage: Stage, card: Card, preferredChapterId?: string) => {
    const { project, nodeIds, chapters } = resolve(card);
    const chapterId = preferredChapterId ?? chapters[0]?.id;
    if (stage === 'brief' || stage === 'outline' || stage === 'chapter') {
      useEditor.setState({
        page: 'outline',
        outlineTarget: stage === 'chapter' ? `chapter:${chapterId}` : stage,
        ...(stage === 'chapter' && chapterId ? { activeChapterId: chapterId } : {}),
      });
    } else if (stage === 'screenplay') {
      useEditor.setState({ page: 'screenplay', activeChapterId: chapterId ?? null });
    } else if (stage === 'preview') {
      useEditor.setState({ playing: true, playFrom: undefined });
    } else {
      useEditor.getState().setChapter(chapterId ?? null);
      const nodeId = nodeIds.find((id) =>
        project.scenes.some(
          (node) =>
            node.id === id && node.kind === 'video' && (!chapterId || node.chapterId === chapterId),
        ),
      );
      if (nodeId) {
        useEditor.getState().focusScene(nodeId);
        if (stage === 'production' || stage === 'materials')
          useEditor.setState({ timelineNodeId: nodeId });
      }
    }
  };

  const proceed = (stage: Stage, next: Stage, card: Card) => {
    const existing = cards.get(next);
    const { project, nodeIds, chapters } = resolve(card);
    const chapter = chapters.find(({ id }) => id === reviewChapters[stage]) ?? chapters[0];
    if (existing || next === 'preview') return review(next, existing ?? card, chapter?.id);
    if ((card.chapterIds.size && !chapters.length) || (card.nodeIds.size && !nodeIds.length)) {
      useEditor.getState().notify('这一阶段对应的章节或节点已删除。', 'error');
      return;
    }
    if (chapter) useEditor.getState().setChapter(chapter.id);
    const scopedIds = nodeIds.filter(
      (id) =>
        !chapter || project.scenes.some((node) => node.id === id && node.chapterId === chapter.id),
    );
    if (scopedIds.length) useEditor.getState().select(scopedIds);
    const ordinal = chapter ? project.chapters.indexOf(chapter) + 1 : undefined;
    const scope =
      !card.chapterWide && stage !== 'chapter' && scopedIds.length
        ? 'selected'
        : ordinal
          ? 'active'
          : 'project';
    const target = { scope, ordinal: scope === 'selected' ? undefined : ordinal };
    const design =
      next === 'outline'
        ? { outline: true }
        : next === 'chapter'
          ? { chapter: true, chapters: { kind: 'range', from: 1 } }
          : undefined;
    const skill = {
      outline: 'frameforge-story-outline',
      chapter: 'frameforge-chapter-planning',
      blueprint: 'frameforge-chapter-blueprint',
      screenplay: 'frameforge-node-screenplay',
      production: 'frameforge-node-storyboard',
    }[next as 'outline' | 'chapter' | 'blueprint' | 'screenplay' | 'production'];
    const detail = notes[stage]?.trim();
    const plan =
      next === 'materials' && detail
        ? undefined
        : requestPlanSchema.parse({
            kind: 'execute',
            design,
            skills: skill ? [skill] : [],
            ...(next === 'blueprint' && { blueprint: { ...target, build: true } }),
            ...(next === 'screenplay' && { screenplay: target }),
            ...(next === 'production' && { production: { ...target, fromScreenplay: true } }),
            ...(next === 'materials' && {
              materials: { ...target, generate: true, timeline: true, overlay: true },
            }),
          });
    const stageInstructions: Partial<Record<Stage, string>> = {
      blueprint: '按代表性玩家路线检查可见的铺垫、关键因果、反应和后果，再核对路线篇幅。',
      production:
        '从当前剧本的动作、对白、阅读和反应倒推镜长。按代表性路线核对篇幅和选项前已交代的事实。',
      materials:
        '沿用已保存的镜头卡，出图前核对关键节点的镜长、剧情文字和选项时点。生成缺失首帧并按镜序入轨。若现有计划装不下关键演出，在交付中标出需回分镜调整的节点。',
    };
    const request = `继续${chapter ? `「${chapter.title}」` : ''}的${stageLabels[next]}。使用工程当前已保存的上游内容。${stageInstructions[next] ?? ''}`;
    const options = turn.creativeInput?.options;
    void useAgent
      .getState()
      .send(
        detail ? `${request}\n补充要求：${detail}` : request,
        plan,
        options ? { options } : undefined,
      );
  };
  return (
    <div className="agent-stage-cards">
      {[...cards]
        .sort(([a], [b]) => stages.indexOf(a) - stages.indexOf(b))
        .map(([stage, card]) => {
          const next = stages[stages.indexOf(stage) + 1];
          const nextAction = cards.has(next)
            ? `查看${stageLabels[next]}`
            : nextActionLabels[next as Exclude<Stage, 'brief'>];
          const { chapters } = resolve(card);
          return (
            <section
              className="agent-stage-card"
              key={stage}
              aria-label={`${stageLabels[stage]}已完成`}
            >
              <strong>
                {stageLabels[stage]}已完成
                {card.nodeIds.size
                  ? ` · ${card.nodeIds.size} 个节点`
                  : card.chapterIds.size > 1
                    ? ` · ${card.chapterIds.size} 章`
                    : ''}
              </strong>
              {chapters.length > 1 && (
                <select
                  aria-label={`${stageLabels[stage]}章节`}
                  disabled={busy}
                  value={reviewChapters[stage] ?? chapters[0].id}
                  onChange={(event) =>
                    setReviewChapters({ ...reviewChapters, [stage]: event.target.value })
                  }
                >
                  {chapters.map(({ id, title }) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              )}
              {next !== 'preview' && !cards.has(next) && (
                <input
                  aria-label={`${stageLabels[stage]}下一步的补充要求`}
                  disabled={busy}
                  placeholder="补充下一步要求（可选）"
                  maxLength={1600}
                  value={notes[stage] ?? ''}
                  onChange={(event) => setNotes({ ...notes, [stage]: event.target.value })}
                />
              )}
              <div className="agent-stage-actions">
                <button type="button" disabled={busy} onClick={() => proceed(stage, next, card)}>
                  {nextAction}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => review(stage, card, reviewChapters[stage])}
                >
                  回看调整
                </button>
              </div>
            </section>
          );
        })}
    </div>
  );
}
