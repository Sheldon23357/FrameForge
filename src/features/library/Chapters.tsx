import { useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  Plus,
  DotsThree,
  CaretDown,
  CaretRight,
  Play,
  Flag,
  FilmStrip,
  GitBranch,
  Trophy,
  ArrowUp,
  ArrowDown,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react';
import { useEditor } from '../../store/editor';
import { Button, Field, IconButton, Modal } from '../../components/ui';

export function Chapters({ search }: { search: string }) {
  const p = useEditor((s) => s.project);
  const active = useEditor((s) => s.activeChapterId);
  const selected = useEditor((s) => s.selectedIds);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'new' | 'edit' | 'delete'; id?: string } | null>(
    null,
  );
  const [title, setTitle] = useState('');
  const [entry, setEntry] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const editing = p.chapters.find((c) => c.id === dialog?.id);
  const members = p.scenes.filter((s) => s.chapterId === editing?.id);
  const open = (kind: 'new' | 'edit' | 'delete', id?: string) => {
    const chapter = p.chapters.find((c) => c.id === id);
    let index = p.chapters.length + 1;
    while (p.chapters.some((c) => c.title === `第 ${index} 章`)) index++;
    setTitle(chapter?.title ?? `第 ${index} 章`);
    setEntry(chapter?.startNodeId ?? '');
    setTarget(p.chapters.find((c) => c.id !== id)?.id ?? '');
    setError('');
    setDialog({ kind, id });
  };
  const submit = () => {
    try {
      const editor = useEditor.getState();
      if (dialog?.kind === 'new') editor.addChapter(title);
      if (dialog?.kind === 'edit' && editing) {
        editor.renameChapter(editing.id, title, entry || undefined);
      }
      if (dialog?.kind === 'delete' && editing)
        editor.deleteChapter(editing.id, members.length ? target : undefined);
      setDialog(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const query = search.trim().toLocaleLowerCase();
  return (
    <>
      <div className="library-subtitle chapter-list-toolbar">
        <span>{p.chapters.length} 个章节</span>
        <Button className="small" onClick={() => open('new')}>
          <Plus size={13} />
          新建章节
        </Button>
      </div>
      <div className="outline-list">
        {p.chapters.map((chapter, index) => {
          const scenes = p.scenes.filter((s) => s.chapterId === chapter.id);
          const matchesChapter = chapter.title.toLocaleLowerCase().includes(query);
          const matches = matchesChapter
            ? scenes
            : scenes.filter((s) =>
                `${s.title} ${s.notes} ${s.endingText}`.toLocaleLowerCase().includes(query),
              );
          if (query && !matchesChapter && !matches.length) return null;
          const expanded = !!query || !collapsed.has(chapter.id);
          return (
            <section
              key={chapter.id}
              className={`chapter-section ${active === chapter.id ? 'current' : ''}`}
              data-chapter-id={chapter.id}
            >
              <div
                className="chapter-heading"
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/frameforge-scenes')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(e) => {
                  const raw = e.dataTransfer.getData('application/frameforge-scenes');
                  if (!raw) return;
                  e.preventDefault();
                  try {
                    const ids: unknown = JSON.parse(raw);
                    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string'))
                      useEditor.getState().moveScenes(ids, chapter.id);
                  } catch {
                    useEditor.getState().notify('节点移动失败。', 'error');
                  }
                }}
              >
                <IconButton
                  label={`${expanded ? '收起' : '展开'} ${chapter.title}`}
                  aria-expanded={expanded}
                  onClick={() =>
                    setCollapsed((old) => {
                      const next = new Set(old);
                      next.has(chapter.id) ? next.delete(chapter.id) : next.add(chapter.id);
                      return next;
                    })
                  }
                >
                  {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
                </IconButton>
                <button
                  className="chapter-name"
                  aria-label={`编辑章节 ${chapter.title}`}
                  aria-pressed={active === chapter.id}
                  onClick={() => useEditor.getState().setChapter(chapter.id)}
                >
                  <span>{chapter.title}</span>
                  <small>{scenes.length}</small>
                </button>
                <Dropdown.Root>
                  <Dropdown.Trigger asChild>
                    <IconButton label={`管理章节 ${chapter.title}`}>
                      <DotsThree size={17} />
                    </IconButton>
                  </Dropdown.Trigger>
                  <Dropdown.Portal>
                    <Dropdown.Content className="dropdown-content" sideOffset={4} align="start">
                      <Dropdown.Item
                        onSelect={() => {
                          useEditor.getState().setChapter(chapter.id);
                          useEditor.getState().addScene('video');
                        }}
                      >
                        <Plus />
                        添加节点
                      </Dropdown.Item>
                      <Dropdown.Item onSelect={() => open('edit', chapter.id)}>
                        <PencilSimple />
                        章节设置
                      </Dropdown.Item>
                      <Dropdown.Item
                        disabled={!chapter.startNodeId}
                        onSelect={() => useEditor.getState().focusScene(chapter.startNodeId)}
                      >
                        <Flag />
                        定位章节起点
                      </Dropdown.Item>
                      <Dropdown.Item
                        disabled={!chapter.startNodeId}
                        onSelect={() =>
                          useEditor.setState({ playing: true, playFrom: chapter.startNodeId })
                        }
                      >
                        <Play />
                        试玩本章
                      </Dropdown.Item>
                      <Dropdown.Separator />
                      <Dropdown.Item
                        disabled={index === 0}
                        onSelect={() => useEditor.getState().reorderChapter(chapter.id, -1)}
                      >
                        <ArrowUp />
                        上移章节
                      </Dropdown.Item>
                      <Dropdown.Item
                        disabled={index === p.chapters.length - 1}
                        onSelect={() => useEditor.getState().reorderChapter(chapter.id, 1)}
                      >
                        <ArrowDown />
                        下移章节
                      </Dropdown.Item>
                      <Dropdown.Separator />
                      <Dropdown.Item
                        disabled={p.chapters.length === 1}
                        onSelect={() => open('delete', chapter.id)}
                      >
                        <Trash />
                        删除章节
                      </Dropdown.Item>
                    </Dropdown.Content>
                  </Dropdown.Portal>
                </Dropdown.Root>
              </div>
              {expanded && (
                <div className="chapter-nodes">
                  {matches.map((s) => {
                    const Icon =
                      s.kind === 'branch' ? GitBranch : s.kind === 'ending' ? Trophy : FilmStrip;
                    return (
                      <button
                        key={s.id}
                        className={selected.includes(s.id) ? 'active' : ''}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            'application/frameforge-scenes',
                            JSON.stringify(selected.includes(s.id) ? selected : [s.id]),
                          );
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={(e) => {
                          if (e.shiftKey) {
                            if (active && active !== chapter.id)
                              useEditor.getState().setChapter(null);
                            useEditor
                              .getState()
                              .select(
                                selected.includes(s.id)
                                  ? selected.filter((id) => id !== s.id)
                                  : [...selected, s.id],
                              );
                          } else useEditor.getState().focusScene(s.id);
                        }}
                      >
                        <Icon size={14} />
                        <span>{s.title}</span>
                        {chapter.startNodeId === s.id && <Flag size={11} aria-label="章节起点" />}
                        {p.startNodeId === s.id && <small>起点</small>}
                      </button>
                    );
                  })}
                  {!scenes.length && <div className="chapter-empty">暂无节点</div>}
                </div>
              )}
            </section>
          );
        })}
        {query &&
          !p.chapters.some((c) => c.title.toLocaleLowerCase().includes(query)) &&
          !p.scenes.some((s) =>
            `${s.title} ${s.notes} ${s.endingText}`.toLocaleLowerCase().includes(query),
          ) && <div className="chapter-empty">无结果</div>}
      </div>
      <Modal
        open={!!dialog}
        onOpenChange={(v) => !v && setDialog(null)}
        title={
          dialog?.kind === 'new' ? '新建章节' : dialog?.kind === 'delete' ? '删除章节' : '章节设置'
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {dialog?.kind === 'delete' ? (
            <>
              <p className="chapter-delete-message">
                删除「{editing?.title}」
                {members.length
                  ? `，将 ${members.length} 个节点移入所选章节。节点内容与剧情连线会保留。`
                  : '，此章节没有节点。'}
              </p>
              {!!members.length && (
                <Field label="节点移入章节">
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    {p.chapters
                      .filter((c) => c.id !== editing?.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="章节名称">
                <input
                  autoFocus
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              {dialog?.kind === 'edit' && (
                <Field label="章节起点">
                  <select
                    disabled={!members.length}
                    value={entry}
                    onChange={(e) => setEntry(e.target.value)}
                  >
                    {!members.length && <option value="">暂无节点</option>}
                    {members.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
          {error && (
            <p className="chapter-form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button type="button" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button type="submit" variant={dialog?.kind === 'delete' ? 'danger' : 'primary'}>
              {dialog?.kind === 'new'
                ? '创建章节'
                : dialog?.kind === 'delete'
                  ? '删除并保留节点'
                  : '保存章节'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
