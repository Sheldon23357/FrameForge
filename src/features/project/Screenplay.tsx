import { useMemo, useState } from 'react';
import { PencilSimple, Plus } from '@phosphor-icons/react';
import { readScreenplayRoute } from '../../../packages/agent/tools/screenplay';
import type { StoryRouteStep } from '../../../packages/agent/tools/route-simulation';
import {
  screenplayKinds,
  screenplayNeedsReview,
  updateScreenplay,
  type ScreenplayBlock,
} from '../../../packages/domain/screenplay';
import { useEditor } from '../../store/editor';
import { Button } from '../../components/ui';
import { commitAgentTransaction } from '../agent/editor-host';
import { ChapterDirectory, ChapterSelect } from './ChapterDirectory';

type Entry = NonNullable<import('../../../packages/domain/schema').Project['screenplays']>[number];
type DraftBlock = { kind: ScreenplayBlock['kind']; text: string; speaker: string };
const emptyRoute: StoryRouteStep[] = [];

function ScreenplayNode({
  nodeId,
  title,
  entry,
}: {
  nodeId: string;
  title: string;
  entry?: Entry;
}) {
  const [draft, setDraft] = useState<DraftBlock[]>();
  const [base, setBase] = useState<string>();
  const [error, setError] = useState('');
  const project = useEditor((state) => state.project);
  const review = entry && screenplayNeedsReview(project, nodeId, entry.version);
  const blank = (): DraftBlock => ({ kind: 'action', text: '', speaker: '' });
  const save = () => {
    if (!draft) return;
    const editor = useEditor.getState();
    if (editor.project.screenplays?.find(({ id }) => id === nodeId)?.version !== base) {
      setError('该节点正文已有新版本。请取消编辑并查看最新版本。');
      return;
    }
    try {
      const candidate = structuredClone(editor.project);
      const blocks = draft.map(({ kind, text, speaker }): ScreenplayBlock =>
        kind === 'dialogue' || kind === 'monologue' ? { kind, text, speaker } : { kind, text },
      );
      updateScreenplay(candidate, nodeId, blocks);
      if (!commitAgentTransaction(editor.project, candidate, [], editor.changeSerial))
        throw new Error('正文未保存，请结束试玩后重试。');
      setDraft(undefined);
      setError('');
    } catch (issue) {
      setError(
        issue instanceof Error && issue.name !== 'ZodError'
          ? issue.message
          : '请填写每段内容和对白、独白的说话人。',
      );
    }
  };
  const patch = (index: number, change: Partial<DraftBlock>) =>
    setDraft((blocks) =>
      blocks?.map((block, i) => (i === index ? { ...block, ...change } : block)),
    );
  if (draft)
    return (
      <div className="screenplay-blocks">
        <h2>{title}</h2>
        {draft.map((block, index) => (
          <fieldset key={index} className="screenplay-edit-block">
            <legend>第 {index + 1} 段</legend>
            <div className="screenplay-controls">
              <select
                aria-label={`第 ${index + 1} 段类型`}
                value={block.kind}
                onChange={(e) => patch(index, { kind: e.target.value as DraftBlock['kind'] })}
              >
                {Object.entries(screenplayKinds).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
              {(block.kind === 'dialogue' || block.kind === 'monologue') && (
                <input
                  aria-label={`第 ${index + 1} 段说话人`}
                  placeholder="说话人"
                  value={block.speaker}
                  maxLength={120}
                  onChange={(e) => patch(index, { speaker: e.target.value })}
                />
              )}
              <Button
                disabled={draft.length === 1}
                onClick={() => setDraft(draft.filter((_, i) => i !== index))}
              >
                删除段落
              </Button>
            </div>
            <textarea
              aria-label={`第 ${index + 1} 段内容`}
              rows={3}
              value={block.text}
              maxLength={2000}
              onChange={(e) => patch(index, { text: e.target.value })}
            />
          </fieldset>
        ))}
        {error && <p role="alert">{error}</p>}
        <div className="screenplay-controls">
          <Button disabled={draft.length >= 100} onClick={() => setDraft([...draft, blank()])}>
            <Plus size={14} aria-hidden="true" />
            添加段落
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(undefined);
              setError('');
            }}
          >
            取消
          </Button>
          <Button variant="primary" onClick={save}>
            保存正文
          </Button>
        </div>
      </div>
    );
  return (
    <div className="screenplay-blocks">
      <header className="screenplay-node-heading">
        <h2>{title}</h2>
        <Button
          variant={entry ? 'ghost' : 'default'}
          onClick={() => {
            setBase(entry?.version);
            setDraft(
              entry?.blocks.map((block) => ({
                ...block,
                speaker: 'speaker' in block ? block.speaker : '',
              })) ?? [blank()],
            );
          }}
        >
          <PencilSimple size={15} aria-hidden="true" />
          {entry ? '编辑正文' : '编写正文'}
        </Button>
      </header>
      {review && <small>已有镜头或玩家文字待复核</small>}
      {entry ? (
        entry.blocks.map((block, index) => (
          <div className="screenplay-block" data-kind={block.kind} key={index}>
            <strong>
              {screenplayKinds[block.kind]}
              {'speaker' in block ? ` · ${block.speaker}` : ''}
            </strong>
            <p>{block.text}</p>
          </div>
        ))
      ) : (
        <p className="screenplay-empty">正文待写</p>
      )}
    </div>
  );
}

export function Screenplay({ hidden }: { hidden: boolean }) {
  const project = useEditor((state) => state.project);
  const active = useEditor((state) => state.activeChapterId);
  const chapter = project.chapters.find(({ id }) => id === active) ?? project.chapters[0];
  const [routes, setRoutes] = useState<Record<string, StoryRouteStep[]>>({});
  const steps = routes[chapter.id] ?? emptyRoute;
  const setSteps = (next: StoryRouteStep[]) =>
    setRoutes((current) => ({ ...current, [chapter.id]: next }));
  const selectChapter = (id: string) => useEditor.setState({ activeChapterId: id });
  const result = useMemo(() => {
    if (hidden || !chapter.startNodeId) return {};
    try {
      return { route: readScreenplayRoute(project, chapter.id, steps, true) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [project, chapter.id, chapter.startNodeId, steps, hidden]);
  if (hidden) return null;
  const { route, error } = result;
  const decision = route?.decision;
  const rows = route?.rows ?? [];
  const choiceNames = new Map(
    project.scenes.flatMap((scene) => scene.choices.map(({ id, label }) => [id, label])),
  );
  const chosen = steps.flatMap((step) =>
    step.action === 'choose' ? [choiceNames.get(step.choiceId)] : [],
  );
  return (
    <section className="story-design-page" aria-label="章节剧本">
      <div className="story-design-layout">
        <ChapterDirectory
          chapters={project.chapters}
          chapterId={chapter.id}
          onSelect={selectChapter}
        />
        <div className="story-design-workspace screenplay-workspace">
          <ChapterSelect
            chapters={project.chapters}
            chapterId={chapter.id}
            label="正文章节"
            onSelect={selectChapter}
          />
          <header className="story-design-document">
            <h1>{chapter.title}</h1>
          </header>
          {steps.length > 0 && (
            <div className="screenplay-route-status">
              {chosen.length > 0 && (
                <div className="screenplay-route-history" aria-label="已选路线">
                  {chosen.map((name, index) => (
                    <span key={index}>{name}</span>
                  ))}
                </div>
              )}
              <div className="screenplay-controls">
                <Button variant="ghost" onClick={() => setSteps(steps.slice(0, -1))}>
                  {steps.at(-1)?.action === 'wait' ? '撤销等待' : '退回上一选项'}
                </Button>
                <Button variant="ghost" onClick={() => setSteps([])}>
                  重选路线
                </Button>
              </div>
            </div>
          )}
          <div className={rows.length > 1 ? 'screenplay-layout has-outline' : 'screenplay-layout'}>
            {rows.length > 1 && (
              <nav className="screenplay-outline" aria-label="本路线节点">
                <strong>本路线节点</strong>
                <ol>
                  {rows.map((row, index) => (
                    <li key={`${row.id}:${index}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const target = document.getElementById(`screenplay-node-${index}`);
                          target?.scrollIntoView({ block: 'start' });
                          target?.focus({ preventScroll: true });
                        }}
                      >
                        {row.title}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <div className="screenplay-reading">
              {error && <p role="alert">{error}</p>}
              {!chapter.startNodeId && (
                <p className="screenplay-empty">在画布设置本章起点后，即可阅读和编写本章剧本。</p>
              )}
              {rows.map((row, index) => (
                <article
                  className="screenplay-node"
                  id={`screenplay-node-${index}`}
                  tabIndex={-1}
                  data-kind={row.kind}
                  key={`${row.id}:${index}`}
                >
                  {row.kind === 'video' ? (
                    <ScreenplayNode nodeId={row.id} title={row.title} entry={row.entry} />
                  ) : (
                    <>
                      <h2>{row.title}</h2>
                      <p>
                        {row.kind === 'branch'
                          ? `自动判定${row.target ? ` → ${row.target}` : ''}`
                          : row.endingText || '结局'}
                      </p>
                    </>
                  )}
                </article>
              ))}
              {decision && (
                <section className="screenplay-node screenplay-decision" aria-label="路线选择">
                  <h2>{decision.title}</h2>
                  {decision.question && <p>{decision.question}</p>}
                  <div className="screenplay-controls">
                    {decision.options.map((choice) => (
                      <Button
                        key={choice.id}
                        disabled={!choice.enabled || steps.length >= 50}
                        title={choice.enabled ? undefined : choice.lockedHint}
                        onClick={() =>
                          setSteps([...steps, { action: 'choose', choiceId: choice.id }])
                        }
                      >
                        {choice.label}
                      </Button>
                    ))}
                    {decision.remainingMs > 0 && (
                      <Button
                        disabled={steps.length >= 50}
                        onClick={() =>
                          setSteps([...steps, { action: 'wait', durationMs: decision.remainingMs }])
                        }
                      >
                        播放到节点末尾
                      </Button>
                    )}
                  </div>
                  {steps.length >= 50 && <p>已读到本章路线的 50 步上限。</p>}
                </section>
              )}
              {route?.chapterExited && <p>本路线已离开本章。</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
