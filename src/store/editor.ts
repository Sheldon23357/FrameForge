import { create } from 'zustand';
import { removeProductionShots } from '../../packages/domain/production-shots';
import { removeScreenplays } from '../../packages/domain/screenplay';
import { removeChapterDesign } from '../../packages/domain/story-design';
import {
  initialVersion,
  recordVersion,
  type ProjectVersion,
} from '../../packages/domain/project-versions';
import {
  makeProject,
  makeScene,
  storyStartId,
  uid,
  type Asset,
  type Chapter,
  type Condition,
  type Project,
  type Scene,
} from '../../packages/domain/schema';

type Page = 'blueprint' | 'outline' | 'screenplay' | 'data' | 'world' | 'settings';
interface EditorState {
  project: Project;
  changeSerial: number;
  projectLoadSerial: number;
  selectedIds: string[];
  page: Page;
  outlineTarget?: string;
  libraryTab: 'assets' | 'scenes';
  search: string;
  past: Project[];
  future: Project[];
  versions: ProjectVersion[];
  dirty: boolean;
  savedAt: string;
  filePath?: string;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  toast?: { message: string; kind: 'info' | 'error' };
  playing: boolean;
  playFrom?: string;
  diagnosticsOpen: boolean;
  focusNodeId?: string;
  timelineNodeId?: string;
  draggedAssetId?: string;
  activeChapterId: string | null;
  setChapter: (id: string | null) => void;
  focusScene: (id: string) => void;
  addChapter: (title: string) => string;
  renameChapter: (id: string, title: string, startNodeId?: string) => void;
  reorderChapter: (id: string, direction: -1 | 1) => void;
  deleteChapter: (id: string, targetChapterId?: string) => void;
  moveScenes: (ids: string[], chapterId: string) => void;
  setChapterEntry: (chapterId: string, nodeId: string) => void;
  load: (p: Project, filePath?: string, versions?: ProjectVersion[]) => void;
  commit: (
    fn: (p: Project) => void,
    group?: string,
    versionTitle?: string,
    keepGroup?: boolean,
  ) => void;
  patchScene: (id: string, patch: Partial<Scene>) => void;
  select: (ids: string[]) => void;
  setPage: (page: Page) => void;
  setSearch: (s: string) => void;
  addScene: (kind: Scene['kind'], position?: { x: number; y: number }, assetId?: string) => string;
  deleteScenes: (ids: string[]) => void;
  duplicate: (ids: string[]) => void;
  addAssets: (assets: Asset[]) => void;
  undo: () => void;
  redo: () => void;
  sealVersion: () => void;
  notify: (message: string, kind?: 'info' | 'error') => void;
}
let groupKey = '';
let groupTime = 0;
let toastTimer: ReturnType<typeof setTimeout>;
function repairEntries(p: Project) {
  for (const chapter of p.chapters) {
    if (!p.scenes.some((s) => s.id === chapter.startNodeId && s.chapterId === chapter.id))
      chapter.startNodeId = p.scenes.find((s) => s.chapterId === chapter.id)?.id ?? '';
  }
}
function validTitle(p: Project, title: string, exceptId?: string) {
  const result = title.trim();
  if (!result || result.length > 200) throw new Error('章节名称须为 1–200 个字符。');
  if (p.chapters.some((c) => c.id !== exceptId && c.title === result))
    throw new Error('已存在同名章节。');
  return result;
}
function viewAfterChange(p: Project, state: EditorState) {
  const activeChapterId = p.chapters.some((c) => c.id === state.activeChapterId)
    ? state.activeChapterId
    : null;
  return {
    activeChapterId,
    selectedIds: state.selectedIds.filter((id) =>
      p.scenes.some((s) => s.id === id && (!activeChapterId || s.chapterId === activeChapterId)),
    ),
  };
}
const initial = makeProject();
export const useEditor = create<EditorState>((set, get) => ({
  project: initial,
  versions: initialVersion(initial),
  changeSerial: 0,
  projectLoadSerial: 0,
  selectedIds: [initial.startNodeId],
  page: 'blueprint',
  libraryTab: 'assets',
  search: '',
  past: [],
  future: [],
  dirty: false,
  savedAt: '',
  saveStatus: 'idle',
  playing: false,
  diagnosticsOpen: false,
  activeChapterId: null,
  setChapter: (id) => {
    if (id && !get().project.chapters.some((c) => c.id === id)) return;
    set({
      activeChapterId: id,
      selectedIds: [],
      focusNodeId: undefined,
      page: 'blueprint',
    });
  },
  focusScene: (id) => {
    const scene = get().project.scenes.find((s) => s.id === id);
    if (!scene) return;
    set({
      selectedIds: [id],
      focusNodeId: id,
      page: 'blueprint',
      activeChapterId: get().activeChapterId ? scene.chapterId : null,
    });
  },
  addChapter: (title) => {
    const chapter: Chapter = {
      id: uid('chapter'),
      title: validTitle(get().project, title),
      startNodeId: '',
    };
    get().commit((p) => {
      p.chapters.push(chapter);
    });
    get().setChapter(chapter.id);
    set({ libraryTab: 'scenes' });
    return chapter.id;
  },
  renameChapter: (id, title, startNodeId) => {
    const name = validTitle(get().project, title, id);
    const chapter = get().project.chapters.find((c) => c.id === id);
    if (!chapter) throw new Error('章节不存在。');
    if (
      startNodeId &&
      !get().project.scenes.some((s) => s.id === startNodeId && s.chapterId === id)
    )
      throw new Error('章节起点必须属于本章。');
    if (chapter.title === name && (!startNodeId || startNodeId === chapter.startNodeId)) return;
    get().commit((p) => {
      const target = p.chapters.find((c) => c.id === id)!;
      target.title = name;
      if (startNodeId) target.startNodeId = startNodeId;
    });
  },
  reorderChapter: (id, direction) => {
    const index = get().project.chapters.findIndex((c) => c.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= get().project.chapters.length) return;
    get().commit((p) => {
      [p.chapters[index], p.chapters[next]] = [p.chapters[next], p.chapters[index]];
    });
  },
  deleteChapter: (id, targetChapterId) => {
    const p = get().project;
    if (!p.chapters.some((c) => c.id === id)) return;
    if (p.chapters.length === 1) throw new Error('作品至少需要保留一个章节。');
    if (
      targetChapterId === id ||
      (targetChapterId && !p.chapters.some((c) => c.id === targetChapterId))
    )
      throw new Error('请选择有效的接收章节。');
    if (p.scenes.some((s) => s.chapterId === id) && !targetChapterId)
      throw new Error('请先选择节点要移入的章节。');
    const wasActive = get().activeChapterId === id;
    get().commit((draft) => {
      for (const s of draft.scenes) if (s.chapterId === id) s.chapterId = targetChapterId!;
      draft.chapters = draft.chapters.filter((c) => c.id !== id);
      removeChapterDesign(draft, id);
      repairEntries(draft);
    });
    if (wasActive) get().setChapter(targetChapterId ?? null);
  },
  moveScenes: (ids, chapterId) => {
    if (!get().project.chapters.some((c) => c.id === chapterId))
      throw new Error('目标章节不存在。');
    if (!get().project.scenes.some((s) => ids.includes(s.id) && s.chapterId !== chapterId)) return;
    get().commit((p) => {
      for (const s of p.scenes) if (ids.includes(s.id)) s.chapterId = chapterId;
      repairEntries(p);
    });
  },
  setChapterEntry: (chapterId, nodeId) => {
    const p = get().project;
    if (!p.scenes.some((s) => s.id === nodeId && s.chapterId === chapterId))
      throw new Error('章节起点必须属于本章。');
    if (p.chapters.find((c) => c.id === chapterId)?.startNodeId === nodeId) return;
    get().commit((p) => {
      p.chapters.find((c) => c.id === chapterId)!.startNodeId = nodeId;
    });
  },
  load: (project, filePath, versions) => {
    groupKey = '';
    project = { ...project, startNodeId: storyStartId(project) };
    set({
      project,
      changeSerial: get().changeSerial + 1,
      projectLoadSerial: get().projectLoadSerial + 1,
      selectedIds: [project.startNodeId],
      past: [],
      future: [],
      versions: versions ?? initialVersion(project),
      dirty: false,
      filePath,
      saveStatus: 'idle',
      focusNodeId: undefined,
      draggedAssetId: undefined,
      timelineNodeId: undefined,
      activeChapterId:
        project.scenes.length > 80
          ? (project.scenes.find((scene) => scene.id === project.startNodeId)?.chapterId ?? null)
          : null,
    });
  },
  commit: (fn, group, versionTitle, keepGroup) => {
    const state = get();
    const project = structuredClone(state.project);
    fn(project);
    project.startNodeId = storyStartId(project);
    project.revision = state.project.revision + 1;
    project.updatedAt = new Date().toISOString();
    const merge = !!group && groupKey === group && (keepGroup || Date.now() - groupTime < 700);
    const versions = recordVersion(state.versions, state.project, project, merge, versionTitle);
    if (!versions) return;
    const cancelled = merge && versions[0] === state.versions[1];
    groupKey = cancelled ? '' : (group ?? '');
    groupTime = Date.now();
    set({
      project,
      changeSerial: state.changeSerial + 1,
      ...viewAfterChange(project, state),
      past: merge
        ? cancelled
          ? state.past.slice(0, -1)
          : state.past
        : [...state.past, state.project].slice(-60),
      versions,
      future: [],
      dirty: true,
      saveStatus: 'idle',
    });
  },
  patchScene: (id, patch) => {
    if (patch.chapterId) {
      get().moveScenes([id], patch.chapterId);
      const { chapterId: _chapterId, ...rest } = patch;
      if (!Object.keys(rest).length) return;
      patch = rest;
    }
    get().commit(
      (p) => {
        const scene = p.scenes.find((s) => s.id === id);
        if (scene) Object.assign(scene, patch);
      },
      `scene:${id}:${Object.keys(patch).join(',')}`,
    );
  },
  select: (ids) => set({ selectedIds: ids }),
  setPage: (page) => set({ page, outlineTarget: undefined }),
  setSearch: (search) => set({ search }),
  addScene: (kind, position, assetId) => {
    const state = get();
    const chapterId =
      state.activeChapterId ??
      state.project.scenes.find((s) => s.id === state.selectedIds[0])?.chapterId ??
      state.project.chapters[0].id;
    const scene = makeScene(kind, state.project.scenes.length + 1, chapterId);
    scene.assetId = assetId;
    get().commit((p) => {
      p.scenes.push(scene);
      repairEntries(p);
      p.layout[scene.id] = position ?? {
        x: 250 + Math.random() * 100,
        y: 180 + Math.random() * 100,
      };
    });
    set({ selectedIds: [scene.id], focusNodeId: scene.id });
    return scene.id;
  },
  deleteScenes: (ids) => {
    get().commit((p) => {
      p.scenes = p.scenes.filter((s) => !ids.includes(s.id));
      removeProductionShots(p, ids);
      removeScreenplays(p, ids);
      ids.forEach((id) => delete p.layout[id]);
      for (const s of p.scenes) {
        if (ids.includes(s.nextId)) s.nextId = '';
        for (const c of s.choices) if (ids.includes(c.targetId)) c.targetId = '';
      }
      repairEntries(p);
    });
    set({ selectedIds: [] });
  },
  duplicate: (ids) => {
    const mapping = new Map(ids.map((id) => [id, uid('scene')]));
    const remapCondition = (condition: Condition): Condition => {
      if (condition.kind === 'visited')
        return { ...condition, nodeId: mapping.get(condition.nodeId) ?? condition.nodeId };
      if (condition.kind === 'not') return { ...condition, child: remapCondition(condition.child) };
      if (condition.kind === 'all' || condition.kind === 'any')
        return { ...condition, children: condition.children.map(remapCondition) };
      return condition;
    };
    get().commit((p) => {
      const copies = p.scenes
        .filter((s) => ids.includes(s.id))
        .map((s) => {
          const node = structuredClone(s);
          node.id = mapping.get(s.id)!;
          node.title = `${s.title} 副本`;
          const choiceMapping = new Map(node.choices.map((c) => [c.id, uid('choice')]));
          node.choices = node.choices.map((c) => ({
            ...c,
            id: choiceMapping.get(c.id)!,
            condition: remapCondition(c.condition),
            targetId: mapping.get(c.targetId) ?? c.targetId,
          }));
          node.events = node.events.map((e) => ({ ...e, id: uid('event') }));
          if (node.timeline) {
            node.timeline.videoClips.forEach((c) => (c.id = uid('clip')));
            node.timeline.audioClips.forEach((c) => (c.id = uid('clip')));
          }
          node.nextId = mapping.get(node.nextId) ?? node.nextId;
          const pos = p.layout[s.id] ?? { x: 0, y: 0 };
          p.layout[node.id] = { x: pos.x + 50, y: pos.y + 60 };
          return node;
        });
      p.scenes.push(...copies);
      if (p.screenplays) {
        p.screenplays.push(
          ...p.screenplays.flatMap((entry) => {
            const id = mapping.get(entry.id);
            return id ? [{ ...structuredClone(entry), id }] : [];
          }),
        );
      }
      if (p.productionShots) {
        const shots = p.productionShots.flatMap((shot) => {
          const nodeId = mapping.get(shot.nodeId);
          return nodeId ? [{ ...shot, id: uid('shot'), nodeId }] : [];
        });
        p.productionShots.push(...shots);
      }
    });
    set({ selectedIds: [...mapping.values()] });
  },
  addAssets: (assets) =>
    get().commit((p) => {
      for (const a of assets) {
        const old = p.assets.findIndex((x) => x.id === a.id);
        if (old >= 0) p.assets[old] = a;
        else p.assets.push(a);
      }
    }),
  sealVersion: () => {
    groupKey = '';
  },
  undo: () => {
    const { past, project, future, versions } = get();
    if (!past.length) return;
    groupKey = '';
    const restored = {
      ...past[past.length - 1],
      revision: project.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    set({
      project: restored,
      changeSerial: get().changeSerial + 1,
      ...viewAfterChange(restored, get()),
      past: past.slice(0, -1),
      future: [project, ...future],
      versions: recordVersion(versions, project, restored, false, '撤销修改') ?? versions,
      dirty: true,
      saveStatus: 'idle',
    });
  },
  redo: () => {
    const { past, project, future, versions } = get();
    if (!future.length) return;
    groupKey = '';
    const restored = {
      ...future[0],
      revision: project.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    set({
      project: restored,
      changeSerial: get().changeSerial + 1,
      ...viewAfterChange(restored, get()),
      past: [...past, project],
      future: future.slice(1),
      versions: recordVersion(versions, project, restored, false, '重做修改') ?? versions,
      dirty: true,
      saveStatus: 'idle',
    });
  },
  notify: (message, kind = 'info') => {
    clearTimeout(toastTimer);
    set({ toast: { message, kind } });
    toastTimer = setTimeout(() => set({ toast: undefined }), 4500);
  },
}));
