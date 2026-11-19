import { lazy, Suspense, useState } from 'react';
import { Check, PencilSimple, WarningCircle } from '@phosphor-icons/react';
import {
  chapterHasBlueprint,
  designLabels,
  designStatus,
  readDesign,
  updateDesign,
  type DesignTarget,
} from '../../../packages/domain/story-design';
import { Button, Field, Modal } from '../../components/ui';
import { useEditor } from '../../store/editor';
import { useAgent } from '../../store/agent';
import { discussionDesignText } from '../../../packages/agent/creative-state';
import { commitAgentTransaction } from '../agent/editor-host';
import { ChapterDirectory, ChapterSelect } from './ChapterDirectory';

const StoryDesignPreview = lazy(() => import('./StoryDesignPreview'));
type DesignStatus = keyof typeof designLabels;

function StatusDot({ status }: { status: DesignStatus | 'unsaved' }) {
  const label = status === 'unsaved' ? '未保存' : designLabels[status];
  return (
    <span
      className="story-design-status-dot"
      data-status={status}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

export function StoryOutline({
  hidden,
  preview,
  onEdit,
}: {
  hidden: boolean;
  preview: boolean;
  onEdit: () => void;
}) {
  const project = useEditor((state) => state.project);
  const activeChapterId = useEditor((state) => state.activeChapterId);
  const focusTarget = useEditor((state) => state.outlineTarget);
  const draft = useAgent((state) => state.creativeDraft);
  const selectChapter = (id: string) => {
    useEditor.setState({ outlineTarget: `chapter:${id}`, activeChapterId: id });
  };
  const [buffers, setBuffers] = useState<Record<string, { base?: string; text: string }>>({});
  const [titleEdit, setTitleEdit] = useState<{
    chapterId: string;
    projectLoadSerial: number;
    originalTitle: string;
    value: string;
    error?: string;
  }>();
  if (hidden) return null;

  const chapterId =
    project.chapters.find(({ id }) => id === activeChapterId)?.id ?? project.chapters[0].id;
  const requested = focusTarget ?? 'outline';
  const target: DesignTarget =
    requested === 'brief' || requested === 'outline'
      ? { stage: requested }
      : {
          stage: 'chapter',
          chapterId:
            project.chapters.find(({ id }) => 'chapter:' + id === requested)?.id ?? chapterId,
        };
  const key = target.stage === 'chapter' ? 'chapter:' + target.chapterId : target.stage;
  const entry = readDesign(project, target);
  const status = designStatus(project, target);
  const buffer = buffers[key];
  const text = buffer?.text ?? entry?.text ?? '';
  const changed = text.trim() !== (entry?.text ?? '');
  const conflict = !!buffer && buffer.base !== entry?.version;
  const matchingDraft = discussionDesignText(draft, target);
  const chapter =
    target.stage === 'chapter'
      ? project.chapters.find(({ id }) => id === target.chapterId)
      : undefined;
  const heading = chapter?.title ?? (target.stage === 'brief' ? '项目简报' : '剧情大纲');
  const placeholder =
    target.stage === 'brief'
      ? '写下玩家身份、核心选择和制作范围…'
      : target.stage === 'outline'
        ? '写下故事主线、章节安排、关键分歧与结局…'
        : '用「## 场次 1-1 场名」标记场次，写下情节、选择、后果和接续…';
  const clearBuffer = () => setBuffers(({ [key]: _, ...remaining }) => remaining);
  const edit = (next: string) =>
    setBuffers((previous) => ({
      ...previous,
      [key]: { base: buffer ? buffer.base : entry?.version, text: next },
    }));
  const save = (confirmed: boolean) => {
    const editor = useEditor.getState();
    if (
      editor.project.id !== project.id ||
      readDesign(editor.project, target)?.version !== entry?.version ||
      conflict
    )
      return;
    try {
      const candidate = structuredClone(editor.project);
      updateDesign(candidate, target, text, confirmed);
      if (commitAgentTransaction(editor.project, candidate, [], editor.changeSerial)) clearBuffer();
      else editor.notify('剧情大纲未保存，请结束试玩后重试。', 'error');
    } catch (error) {
      editor.notify(error instanceof Error ? error.message : '剧情大纲保存失败。', 'error');
    }
  };
  const rename = () => {
    if (!titleEdit) return;
    const editor = useEditor.getState();
    const current = editor.project.chapters.find(({ id }) => id === titleEdit.chapterId);
    try {
      if (
        editor.projectLoadSerial !== titleEdit.projectLoadSerial ||
        current?.title !== titleEdit.originalTitle
      )
        throw new Error('章节已更新。请关闭后重新打开修改标题。');
      editor.renameChapter(titleEdit.chapterId, titleEdit.value);
      setTitleEdit(undefined);
    } catch (error) {
      setTitleEdit({
        ...titleEdit,
        error: error instanceof Error ? error.message : '章节标题保存失败。',
      });
    }
  };
  return (
    <section
      className="story-design-page story-outline-page"
      aria-label={target.stage === 'chapter' ? '分章节大纲' : heading}
    >
      <div
        className={
          target.stage === 'chapter' ? 'story-design-layout' : 'story-design-layout single-document'
        }
      >
        {target.stage === 'chapter' && (
          <ChapterDirectory
            chapters={project.chapters}
            chapterId={target.chapterId}
            onSelect={selectChapter}
            status={({ id }) => {
              const rowTarget = { stage: 'chapter', chapterId: id } as const;
              const draftText = buffers[`chapter:${id}`]?.text.trim();
              const unsaved =
                draftText !== undefined &&
                draftText !== (readDesign(project, rowTarget)?.text ?? '');
              return <StatusDot status={unsaved ? 'unsaved' : designStatus(project, rowTarget)} />;
            }}
          />
        )}
        <div className="story-design-workspace">
          {target.stage === 'chapter' && (
            <ChapterSelect
              chapters={project.chapters}
              chapterId={target.chapterId}
              label="选择大纲章节"
              onSelect={selectChapter}
            />
          )}
          {(target.stage === 'chapter' || status !== 'draft' || changed) && (
            <header className="story-design-header story-design-document">
              {chapter && (
                <>
                  <span className="story-design-location">分章节大纲</span>
                  <div className="story-design-chapter-heading">
                    <h1>{heading}</h1>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setTitleEdit({
                          chapterId: chapter.id,
                          projectLoadSerial: useEditor.getState().projectLoadSerial,
                          originalTitle: chapter.title,
                          value: chapter.title,
                        })
                      }
                    >
                      <PencilSimple size={15} aria-hidden="true" />
                      修改标题
                    </Button>
                  </div>
                </>
              )}
              <div className="story-design-meta">
                {status !== 'draft' && (
                  <span className="story-design-status" data-status={status}>
                    {designLabels[status]}
                  </span>
                )}
                {target.chapterId && chapterHasBlueprint(project, target.chapterId) && (
                  <span>
                    <Check size={13} aria-hidden="true" /> 已有蓝图
                  </span>
                )}
                {changed && <span className="story-design-unsaved">未保存</span>}
              </div>
            </header>
          )}
          {conflict && (
            <p className="story-design-conflict" role="alert">
              <WarningCircle size={17} aria-hidden="true" />
              工程中的这份设计已更新。可先复制当前文字，再载入工程版本。
            </p>
          )}
          <div className="story-design-sheet">
            <div className="story-design-editor">
              <div className="story-design-view">
                {preview ? (
                  <Suspense
                    fallback={
                      <div className="story-design-reading">
                        <p className="story-design-placeholder">正在载入预览…</p>
                      </div>
                    }
                  >
                    <StoryDesignPreview key={key} text={text} title={heading} />
                  </Suspense>
                ) : (
                  <textarea
                    key={key}
                    aria-label={heading}
                    value={text}
                    onChange={(event) => edit(event.target.value)}
                    maxLength={20000}
                    spellCheck={false}
                    placeholder={placeholder}
                  />
                )}
              </div>
            </div>
            <footer className="story-design-footer">
              <span className="story-design-format">Markdown</span>
              <div className="story-design-actions">
                {buffer ? (
                  <Button variant="ghost" onClick={clearBuffer}>
                    {conflict ? '载入工程版本' : '放弃未保存修改'}
                  </Button>
                ) : matchingDraft ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      edit(matchingDraft);
                      onEdit();
                    }}
                  >
                    填入最近讨论稿
                  </Button>
                ) : null}
                <Button disabled={!changed || conflict} onClick={() => save(false)}>
                  保存草稿
                </Button>
                <Button
                  variant="primary"
                  disabled={!text.trim() || conflict || (!changed && status === 'confirmed')}
                  onClick={() => save(true)}
                >
                  保存并确认
                </Button>
              </div>
            </footer>
          </div>
        </div>
      </div>
      {titleEdit && (
        <Modal open onOpenChange={(open) => !open && setTitleEdit(undefined)} title="修改章节标题">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              rename();
            }}
          >
            <Field label="章节标题">
              <input
                autoFocus
                maxLength={200}
                value={titleEdit.value}
                onChange={(event) =>
                  setTitleEdit({ ...titleEdit, value: event.target.value, error: undefined })
                }
              />
            </Field>
            {titleEdit.error && (
              <p className="chapter-form-error" role="alert">
                {titleEdit.error}
              </p>
            )}
            <div className="dialog-actions">
              <Button type="button" onClick={() => setTitleEdit(undefined)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={!titleEdit.value.trim()}>
                保存标题
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
