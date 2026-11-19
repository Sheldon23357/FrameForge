import { create } from 'zustand';
import { createEditorTools } from '../../packages/agent/tools';
import { runAgent, type BlueprintDraft } from '../../packages/agent/harness';
import type { CreativeDraft } from '../../packages/agent/creative-state';
import {
  agentRunTimeoutMs,
  newSession,
  type AgentSession,
  type AgentTurn,
  type ContextStats,
  type RollbackTask,
  type SessionInfo,
} from '../../packages/agent/types';
import type { ProviderId } from '../../packages/agent/settings';
import type { Project } from '../../packages/domain/schema';
import { completeRollback, recoverRollback, rollbackDigest } from '../../packages/agent/rollback';
import { mergeProjectEdits } from '../../packages/domain/project-merge';
import {
  changedAssetIds,
  projectAtVersion,
  projectChanges,
  versionInfo,
} from '../../packages/domain/project-versions';
import { platform } from '../platform';
import { agentAPI, requestModel } from '../platform/agent';
import { agentSettings } from '../platform/agent-settings';
import {
  generateProductionAudio,
  generateShotImage,
  generateWorldReference,
} from '../platform/world-reference';
import { commitAgentTransaction } from '../features/agent/editor-host';
import type { RequestPlan } from '../../packages/agent/request-plan';
import type { CreativeInput } from '../../packages/agent/creative-options';
import { useEditor } from './editor';
import { saveVersionHistory } from './version-history';

export const editorTools = createEditorTools();
let controller: AbortController | undefined;
let epoch = 0;
let journalTimer: ReturnType<typeof setTimeout> | undefined;
type AgentEdit = { before: Project; after: Project };
let lastCommit: { turnId: string; project: Project; edits: AgentEdit[] } | undefined;
let pendingSave: Promise<unknown> = Promise.resolve();
interface AgentState {
  projectId: string;
  session?: AgentSession;
  sessions: SessionInfo[];
  pending?: AgentTurn;
  blueprintDraft?: BlueprintDraft;
  preview?: string;
  thoughtSummary?: string;
  creativeDraft?: CreativeDraft;
  busy: boolean;
  loading: boolean;
  phase: string;
  error: string;
  stats?: ContextStats;
  provider: ProviderId;
  modelNames: Record<ProviderId, string>;
  drafts: Record<string, string>;
  setDraftMessage(text: string): void;
  defaultProviderSeen: ProviderId;
  openProject(projectId: string): Promise<void>;
  newChat(): Promise<void>;
  selectChat(id: string): Promise<void>;
  deleteChat(): Promise<void>;
  send(user: string, stagePlan?: RequestPlan, creativeInput?: CreativeInput): Promise<void>;
  stop(): void;
  flush(): Promise<void>;
  pinSelection(): void;
  unpin(id: string): void;
  undoTurn(id: string): Promise<void>;
  rollbackToTurn(id: string): Promise<boolean>;
  setProvider(id: ProviderId): void;
  refreshModels(): Promise<void>;
}
const info = (s: AgentSession): SessionInfo => ({
  id: s.id,
  title: s.title,
  projectId: s.projectId,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});
function enqueueSave(session: AgentSession) {
  const snapshot = structuredClone(session);
  const task = pendingSave.catch(() => {}).then(() => agentAPI.saveSession(snapshot));
  pendingSave = task;
  return task;
}
async function recovered(session: AgentSession | null, project: Project) {
  if (!session) throw new Error('对话不存在。');
  session = await recoverRollback(session, project);
  for (const turn of session.turns)
    if (turn.status === 'running') {
      turn.status = 'stopped';
      turn.error = turn.committed
        ? '上次运行被中断，已保存的批次保留在工程中。'
        : '上次运行被中断，请核对工程和待续跑任务。';
      turn.assistant = session.checkpoint
        ? `${turn.error}\n已校验的草稿和待办可用「继续」恢复。`
        : turn.error;
    }
  return session;
}
export const useAgent = create<AgentState>((set, get) => ({
  projectId: '',
  sessions: [],
  busy: false,
  loading: false,
  phase: '',
  error: '',
  provider: 'openai',
  drafts: {},
  setDraftMessage: (text) => {
    const id = get().session?.id;
    if (id) set({ drafts: { ...get().drafts, [id]: text } });
  },
  defaultProviderSeen: 'openai',
  modelNames: {
    openai: 'gpt-6.1-sol',
    gemini: 'gemini-4-argon',
    deepseek: 'deepseek-v4-flash',
    minimax: 'MiniMax-M3.1-Flash',
    codex: 'default',
  },
  refreshModels: async () => {
    try {
      const settings = await agentSettings.get();
      set({
        provider:
          get().provider === get().defaultProviderSeen ||
          settings.defaultProvider !== get().defaultProviderSeen
            ? settings.defaultProvider
            : get().provider,
        defaultProviderSeen: settings.defaultProvider,
        modelNames: Object.fromEntries(
          Object.entries(settings.providers).map(([id, c]) => [id, c.model]),
        ) as AgentState['modelNames'],
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '无法读取模型配置。' });
    }
  },
  setProvider: (provider) => {
    if (!get().busy) set({ provider });
  },
  openProject: async (projectId) => {
    if (get().projectId === projectId && get().session) return;
    get().stop();
    const current = ++epoch;
    set({
      projectId,
      session: undefined,
      pending: undefined,
      blueprintDraft: undefined,
      thoughtSummary: undefined,
      creativeDraft: undefined,
      sessions: [],
      loading: true,
      busy: false,
      error: '',
      stats: undefined,
    });
    try {
      await pendingSave.catch(() => {});
      const rows = await agentAPI.listSessions(projectId);
      const creativeDraft = await agentAPI.loadCreativeDraft(projectId).catch(() => null);
      const loaded = rows.length ? await agentAPI.loadSession(projectId, rows[0].id) : undefined;
      const recoveringRollback = Boolean(loaded?.rollbackJournal);
      const session = rows.length
        ? await recovered(loaded ?? null, useEditor.getState().project)
        : newSession(projectId);
      if (current !== epoch) return;
      set({
        session,
        creativeDraft:
          session.creativeDraft === undefined
            ? (creativeDraft ?? undefined)
            : (session.creativeDraft ?? undefined),
        sessions: rows.length ? rows : [info(session)],
        loading: false,
      });
      if (!loaded || recoveringRollback) await enqueueSave(session);
      if (current === epoch) await get().refreshModels();
    } catch (error) {
      if (current === epoch)
        set({ loading: false, error: error instanceof Error ? error.message : '读取对话失败。' });
    }
  },
  newChat: async () => {
    if (get().busy || get().loading || !get().projectId) return;
    const session = newSession(get().projectId);
    const current = ++epoch;
    set({ loading: true, error: '' });
    try {
      await enqueueSave(session);
      const draft = await agentAPI.loadCreativeDraft(session.projectId).catch(() => null);
      if (current !== epoch) return;
      set({
        session,
        creativeDraft: draft ?? undefined,
        pending: undefined,
        loading: false,
        stats: undefined,
        error: '',
        sessions: [info(session), ...get().sessions],
      });
    } catch (error) {
      if (current === epoch)
        set({ loading: false, error: error instanceof Error ? error.message : '创建对话失败。' });
    }
  },
  selectChat: async (id) => {
    if (get().busy || get().loading || get().session?.id === id) return;
    const current = ++epoch;
    set({ loading: true, error: '' });
    try {
      const session = await recovered(
        await agentAPI.loadSession(get().projectId, id),
        useEditor.getState().project,
      );
      const draft =
        session.creativeDraft === undefined
          ? await agentAPI.loadCreativeDraft(session.projectId).catch(() => null)
          : session.creativeDraft;
      if (current === epoch)
        set({
          session,
          creativeDraft: draft ?? undefined,
          pending: undefined,
          stats: undefined,
          loading: false,
        });
    } catch (error) {
      if (current === epoch)
        set({ loading: false, error: error instanceof Error ? error.message : '读取对话失败。' });
    }
  },
  deleteChat: async () => {
    const { session, busy, loading } = get();
    if (!session || busy || loading) return;
    const current = ++epoch;
    set({ loading: true, error: '' });
    try {
      await agentAPI.deleteSession(session.projectId, session.id);
      if (current !== epoch) return;
      const rows = get().sessions.filter((s) => s.id !== session.id);
      set({ sessions: rows, session: undefined, pending: undefined, loading: false });
      if (rows.length) await get().selectChat(rows[0].id);
      else await get().newChat();
    } catch (error) {
      if (current === epoch)
        set({ loading: false, error: error instanceof Error ? error.message : '删除对话失败。' });
    }
  },
  send: async (user, stagePlan, creativeInput) => {
    const state = get();
    if (state.busy || state.loading || !state.session || !user.trim()) return;
    if (user.length > 16000) {
      set({ error: '消息不能超过 16000 个字符。' });
      return;
    }
    if (state.session.turns.length >= 999) {
      set({ error: '本对话已达到轮次上限，请新建对话。' });
      return;
    }
    const session = structuredClone(state.session);
    const { project, projectLoadSerial, versions, past, future } = useEditor.getState();
    const { selectedIds, activeChapterId } = useEditor.getState();
    if (session.projectId !== project.id) {
      set({ error: '工程已切换，请等待新工程的对话加载完成。' });
      return;
    }
    const current = epoch;
    const runId = `run_${crypto.randomUUID()}`;
    const active = new AbortController();
    controller = active;
    const timeout = setTimeout(
      () => active.abort(new Error(`创作超过 ${agentRunTimeoutMs / 60_000} 分钟，已停止。`)),
      agentRunTimeoutMs,
    );
    set({
      busy: true,
      error: '',
      phase: '准备上下文',
      pending: undefined,
      blueprintDraft: undefined,
      preview: undefined,
      thoughtSummary: undefined,
    });
    let committedProject: Project | undefined;
    let committedSerial: number | undefined;
    const edits: AgentEdit[] = [];
    let runJournal: ReturnType<typeof setTimeout> | undefined;
    let journalSession = session;
    const journal = (turn: AgentTurn, snapshot = journalSession) => ({
      ...snapshot,
      turns: [...snapshot.turns, turn],
      updatedAt: new Date().toISOString(),
    });
    try {
      const desktop = window.frameforge;
      const skillAPI = desktop?.agentSkills;
      const catalog = await skillAPI?.begin(runId);
      const imageProvider = desktop ? (await agentSettings.get()).imageProvider : undefined;
      if (active.signal.aborted) throw new DOMException('已停止', 'AbortError');
      const result = await runAgent({
        session,
        user: user.trim(),
        stagePlan,
        creativeInput,
        provider: state.provider,
        model: state.modelNames[state.provider],
        project,
        selectedIds: [...selectedIds],
        activeChapterId,
        creativeDraft: state.creativeDraft,
        skills:
          skillAPI && catalog?.length
            ? { catalog, read: (input) => skillAPI.read(runId, input) }
            : undefined,
        media: desktop && {
          imageProvider,
          generateReference: (...args) => generateWorldReference(...args, imageProvider),
          generateShotImage: (...args) => generateShotImage(...args, imageProvider),
          generateProductionAudio,
          importAssets: (category, operationId) =>
            desktop.stageAssetImport(project.id, category, operationId),
        },
        registry: editorTools,
        liveUpdates: true,
        client: requestModel,
        signal: active.signal,
        runId,
        saveCheckpoint: async (snapshot, turn) => {
          clearTimeout(runJournal);
          const next = structuredClone(snapshot);
          await enqueueSave(journal(turn, next));
          journalSession = next;
          if (current === epoch) set({ session: journalSession });
        },
        versions: versions.map(versionInfo),
        projectAtVersion: (id) => projectAtVersion(project, versions, id),
        checkpointBases: () => [...past, ...future],
        commit: async (base, candidate, intents, validateMerged) => {
          for (;;) {
            const latest = useEditor.getState();
            if (
              active.signal.aborted ||
              latest.projectLoadSerial !== projectLoadSerial ||
              latest.playing
            )
              return false;

            const merged =
              latest.project === base
                ? { project: candidate }
                : mergeProjectEdits(base, latest.project, candidate);
            if ('error' in merged) return merged;
            const error = validateMerged?.(latest.project, merged.project);
            if (error) return { error };
            const ids = changedAssetIds(latest.project, merged.project);
            if (ids.length) {
              await platform.ensureVersionAssets(merged.project, ids);
              if (useEditor.getState().changeSerial !== latest.changeSerial) continue;
            }
            if (active.signal.aborted) return false;
            if (
              !commitAgentTransaction(
                latest.project,
                merged.project,
                intents,
                latest.changeSerial,
                { undoGroup: runId },
              )
            )
              return false;
            const applied = useEditor.getState().project;
            if (applied === latest.project) return 'unchanged';
            const previous = edits.at(-1);
            if (previous && latest.changeSerial === committedSerial) previous.after = applied;
            else edits.push({ before: latest.project, after: applied });
            committedProject = applied;
            committedSerial = useEditor.getState().changeSerial;
            await platform.autosave(applied, true);
            return true;
          }
        },
        onEvent: (event) => {
          if (current !== epoch) return;
          if (event.type === 'phase') set({ phase: event.label });
          else if (event.type === 'context') set({ stats: event.stats });
          else if (event.type === 'preview') set({ preview: event.text });
          else if (event.type === 'thoughtSummary') set({ thoughtSummary: event.text });
          else if (event.type === 'blueprintDraft') {
            if (!active.signal.aborted || !event.draft) set({ blueprintDraft: event.draft });
          } else {
            set({ pending: event.turn });
            clearTimeout(runJournal);
            runJournal = setTimeout(() => {
              void enqueueSave(journal(event.turn)).catch(() => {
                if (current === epoch) set({ error: '对话自动保存失败，请检查本机存储空间。' });
              });
            }, 400);
            journalTimer = runJournal;
          }
        },
      });
      clearTimeout(runJournal);
      const draft = result.creativeDraft ?? state.creativeDraft;
      const editor = useEditor.getState();
      if (
        current === epoch &&
        editor.projectLoadSerial === projectLoadSerial &&
        result.turn.status === 'completed'
      ) {
        editor.sealVersion();
        const pendingTask = result.session.checkpoint;
        let task: RollbackTask | undefined;
        if (pendingTask?.hostTask && pendingTask.baseProject) {
          const {
            baseProject,
            draft,
            baseRevision: _revision,
            baseDigest: _digest,
            hostTask,
            ...state
          } = pendingTask;
          const merged = mergeProjectEdits(baseProject, editor.project, draft);
          if ('project' in merged)
            task = { ...state, hostTask, changes: projectChanges(editor.project, merged.project) };
        }
        result.turn.rollback = {
          versionId: editor.versions[0].id,
          pinnedSceneIds: [...result.session.pinnedSceneIds],
          creativeDraft: draft ?? null,
          task,
        };
        await saveVersionHistory(editor.project, editor.versions, editor.filePath).catch(() => {});
      }
      if (session.creativeDraft !== undefined) result.session.creativeDraft = draft ?? null;
      if (current === epoch) {
        if (result.turn.committed && committedProject)
          lastCommit = { turnId: result.turn.id, project: committedProject, edits };
        set({
          session: result.session,
          creativeDraft: result.creativeDraft ?? get().creativeDraft,
          pending: undefined,
          sessions: [
            info(result.session),
            ...get().sessions.filter((s) => s.id !== result.session.id),
          ],
        });
      }
      await Promise.all([
        enqueueSave(result.session),
        result.creativeDraft && session.creativeDraft === undefined
          ? agentAPI.saveCreativeDraft(project.id, result.creativeDraft)
          : undefined,
      ]);
    } catch (error) {
      if (current === epoch)
        set({ error: error instanceof Error ? error.message : '运行或保存对话失败。' });
    } finally {
      clearTimeout(timeout);
      void agentAPI.cancel(runId).catch(() => {});
      clearTimeout(runJournal);
      if (controller === active) controller = undefined;
      if (current === epoch)
        set({
          busy: false,
          phase: '',
          preview: undefined,
          thoughtSummary: undefined,
          blueprintDraft: undefined,
        });
    }
  },
  stop: () => {
    controller?.abort();
    set({ blueprintDraft: undefined });
  },
  flush: async () => {
    clearTimeout(journalTimer);
    await pendingSave.catch(() => {});
    clearTimeout(journalTimer);
    const { session, pending } = get();
    if (session && pending)
      await enqueueSave({
        ...session,
        turns: [
          ...session.turns,
          pending.status === 'running'
            ? {
                ...pending,
                status: 'stopped',
                assistant: pending.committed
                  ? '运行已中断，已保存的批次保留在工程中。'
                  : '运行已中断，请核对工程和待续跑任务。',
              }
            : pending,
        ],
      });
    else if (session) await enqueueSave(session);
    await pendingSave.catch(() => {});
  },
  pinSelection: () => {
    const session = get().session;
    if (!session || get().busy || get().loading) return;
    const ids = [...new Set([...session.pinnedSceneIds, ...useEditor.getState().selectedIds])];
    if (ids.length > 20) {
      set({ error: '最多固定引用 20 个节点。' });
      return;
    }
    const next = { ...session, pinnedSceneIds: ids };
    set({ session: next });
    void enqueueSave(next).catch(() => set({ error: '固定引用保存失败。' }));
  },
  unpin: (id) => {
    const session = get().session;
    if (!session || get().busy || get().loading) return;
    const next = { ...session, pinnedSceneIds: session.pinnedSceneIds.filter((v) => v !== id) };
    set({ session: next });
    void enqueueSave(next).catch(() => set({ error: '固定引用保存失败。' }));
  },
  undoTurn: async (id) => {
    const session = get().session;
    if (
      !session ||
      get().busy ||
      get().loading ||
      !lastCommit ||
      lastCommit.turnId !== id ||
      lastCommit.project !== useEditor.getState().project
    ) {
      set({ error: '工程已有后续操作，请使用顶部撤销逐步恢复。' });
      return;
    }
    const editor = useEditor.getState();
    const current = epoch;
    const { edits } = lastCommit;
    let candidate = editor.project;
    for (const { before, after } of [...edits].reverse()) {
      const merged = mergeProjectEdits(after, candidate, before);
      if ('error' in merged) {
        set({ error: `无法撤销本轮：${merged.error}` });
        return;
      }
      candidate = merged.project;
    }
    set({ loading: true, error: '' });
    try {
      const assets = changedAssetIds(editor.project, candidate);
      if (assets.length) await platform.ensureVersionAssets(candidate, assets);
      const latest = useEditor.getState();
      if (current !== epoch || latest.changeSerial !== editor.changeSerial || latest.playing)
        throw new Error('工程或对话已变化，请重新撤销。');
      if (edits.length === 1 && editor.past.at(-1) === edits[0].before) editor.undo();
      else if (
        !commitAgentTransaction(editor.project, candidate, [], editor.changeSerial, {
          versionTitle: '撤销 Agent 整轮修改',
          historicalDraft: true,
        })
      )
        throw new Error('工程当前无法编辑。');
      const restored = useEditor.getState();
      lastCommit = undefined;
      await platform.autosave(restored.project, true);
      const checkpoints = [
        session.checkpoint,
        ...[...(session.suspendedCheckpoints ?? [])].reverse(),
      ].flatMap((checkpoint) =>
        checkpoint &&
        !checkpoint.writes.some(({ operationId }) => operationId?.startsWith(`${id}:`))
          ? [checkpoint]
          : [],
      );
      const next = {
        ...session,
        checkpoint: checkpoints[0],
        suspendedCheckpoints: checkpoints.slice(1).reverse(),
        turns: session.turns.map((t) => (t.id === id ? { ...t, reverted: true } : t)),
      };
      if (current === epoch) set({ session: next });
      await enqueueSave(next);
    } catch (error) {
      if (current === epoch)
        set({ error: error instanceof Error ? error.message : '撤销记录保存失败。' });
    } finally {
      if (current === epoch) set({ loading: false });
    }
  },
  rollbackToTurn: async (id) => {
    const { session, busy, loading } = get();
    const editor = useEditor.getState();
    if (!session || busy || loading || editor.project.id !== session.projectId || editor.playing)
      return false;
    const index = session.turns.findIndex((turn) => turn.id === id);
    const point = session.turns[index]?.rollback;
    if (!point) return false;

    const current = epoch;
    const updatedAt = new Date().toISOString();
    set({ loading: true, error: '' });
    let staged: AgentSession | undefined;
    let applied = false;
    try {
      const candidate = projectAtVersion(editor.project, editor.versions, point.versionId);
      const targetDigest = await rollbackDigest(candidate);
      const assets = changedAssetIds(editor.project, candidate);
      if (assets.length) await platform.ensureVersionAssets(candidate, assets);
      const unchanged = () =>
        epoch === current &&
        get().session === session &&
        useEditor.getState().changeSerial === editor.changeSerial &&
        !useEditor.getState().playing;
      if (!unchanged()) throw new Error('工程或对话已变化，请重新选择回退点。');
      staged = { ...session, rollbackJournal: { turnId: id, targetDigest, updatedAt } };
      await enqueueSave(staged);
      if (
        !unchanged() ||
        !commitAgentTransaction(editor.project, candidate, [], editor.changeSerial, {
          historicalDraft: true,
          versionTitle: `回退到 Agent 第 ${index + 1} 轮`,
        })
      )
        throw new Error('工程或对话已变化，请重新选择回退点。');
      applied = true;
      lastCommit = undefined;
      const restored = useEditor.getState();
      await platform.autosave(restored.project, true);
      await saveVersionHistory(restored.project, restored.versions, restored.filePath).catch(
        () => {},
      );
      const next = await completeRollback(session, restored.project, id, updatedAt);
      await enqueueSave(next);
      if (current !== epoch) return true;
      set({
        session: next,
        creativeDraft: point.creativeDraft ?? undefined,
        drafts: { ...get().drafts, [next.id]: '' },
        pending: undefined,
        stats: undefined,
        sessions: [info(next), ...get().sessions.filter((row) => row.id !== next.id)],
      });
      return true;
    } catch (error) {
      let message = error instanceof Error ? error.message : '回退失败。';
      if (staged && !applied) {
        try {
          await enqueueSave(session);
        } catch {
          message += ' 原对话保存失败。';
        }
      }
      if (current === epoch)
        set({
          ...(applied && staged && { session: staged }),
          error: applied ? `工程回退已应用，保存尚未完成。 ${message}` : message,
        });
      return false;
    } finally {
      if (current === epoch) set({ loading: false });
    }
  },
}));
