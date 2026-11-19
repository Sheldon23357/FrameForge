import { describe, expect, it, vi } from 'vitest';
import { testProject } from '../fixtures/project';
import {
  audioSourceMs,
  audioVolumeAt,
  editableTimeline,
  editTimeline,
  nodeDuration,
  stillAt,
  stillClipsFor,
  videoAt,
} from '../../packages/domain/timeline';
import { parseProject } from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
import { advance, loadGame, saveGame, sceneDuration, start } from '../../packages/runtime/engine';
import { createEditorTools } from '../../packages/agent/tools';
import { runAgent } from '../fixtures/agent-intent';
import { newSession, type ToolContext } from '../../packages/agent/types';
import { commitAgentTransaction } from '../../src/features/agent/editor-host';
import { useEditor } from '../../src/store/editor';
import { prepareGameProject } from '../../packages/export/project';
import { webAssetPaths } from '../../packages/export/web';

function fixture() {
  const p = testProject();
  p.assets.push({
    ...p.assets[0],
    id: 'bgm',
    type: 'audio',
    path: 'assets/music.wav',
    durationMs: 4000,
    thumbnail: undefined,
    builtin: false,
  });
  return p;
}
describe('node timeline semantics', () => {
  it('keeps fades on the whole audio clip across loops and restores their gain from node time', () => {
    const clip = {
      id: 'fade',
      assetId: 'bgm',
      trimStartMs: 1000,
      trimEndMs: 3000,
      startMs: 500,
      durationMs: 6000,
      loop: true,
      volume: 0.25,
      fadeInMs: 1000,
      fadeOutMs: 1000,
    };
    expect(audioVolumeAt(clip, 499)).toBe(0);
    expect(audioVolumeAt(clip, 500)).toBe(0);
    expect(audioVolumeAt(clip, 1000)).toBeCloseTo(0.125);
    expect(audioVolumeAt(clip, 2500)).toBe(0.25); // loop boundary must not restart the fade
    expect(audioVolumeAt(clip, 6000)).toBeCloseTo(0.125);
    expect(audioVolumeAt(clip, 6500)).toBe(0);
    const p = fixture();
    const scene = p.scenes[0];
    const id = editTimeline(p, scene.id, { action: 'add', track: 'audio', assetId: 'bgm' });
    editTimeline(p, scene.id, {
      action: 'update_audio',
      clipId: id,
      patch: {
        startMs: 500,
        durationMs: 6000,
        loop: true,
        volume: 0.25,
        fadeInMs: 1000,
        fadeOutMs: 1000,
      },
    });
    const playable = parseProject(p);
    const restored = loadGame(
      playable,
      saveGame(playable, advance(playable, start(playable), 1000)),
    );
    expect(audioVolumeAt(scene.timeline!.audioClips[0], restored.positionMs)).toBeCloseTo(0.125);
    expect(prepareGameProject(p).scenes[0].timeline!.audioClips[0]).toMatchObject({
      fadeInMs: 1000,
      fadeOutMs: 1000,
    });
    const before = structuredClone(p);
    expect(() =>
      editTimeline(p, scene.id, { action: 'update_audio', clipId: id, patch: { fadeInMs: -1 } }),
    ).toThrow();
    expect(p).toEqual(before);
  });
  it('keeps old project trimming and converts it without losing the original video', () => {
    const p = fixture();
    const s = p.scenes[0];
    s.trimStartMs = 1000;
    s.trimEndMs = 7000;
    expect(sceneDuration(parseProject(p), s)).toBe(6000);
    expect(s.timeline).toBeUndefined();
    const id = editTimeline(p, s.id, { action: 'add', track: 'audio', assetId: 'bgm' });
    expect(s.timeline!.videoClips[0]).toMatchObject({
      assetId: 'asset_primary',
      trimStartMs: 1000,
      trimEndMs: 7000,
    });
    expect(s.timeline!.audioClips[0].id).toBe(id);
    expect(sceneDuration(p, s)).toBe(6000);
    expect(parseProject(p).scenes[0].timeline).toEqual(s.timeline);
    const imported = structuredClone(p);
    imported.scenes[0].assetId = 'stale_legacy_poster';
    imported.scenes[0].trimStartMs = 9999;
    const normalized = parseProject(imported);
    expect(normalized.scenes[0]).toMatchObject({ assetId: 'asset_primary', trimStartMs: 0 });
    expect(validateProject(normalized).some((i) => i.severity === 'error')).toBe(false);
  });
  it('uses node time across cut boundaries, triggers an event once and restores within the second clip', () => {
    const p = fixture();
    const s = p.scenes[0];
    s.choicesAtMs = 6500;
    s.timeline = {
      videoClips: [
        { id: 'a', assetId: 'asset_primary', trimStartMs: 1000, trimEndMs: 4000, volume: 0 },
        { id: 'b', assetId: 'asset_secondary', trimStartMs: 2000, trimEndMs: 6000, volume: 1 },
      ],
      audioClips: [],
    };
    s.events = [
      {
        id: 'cut_event',
        name: '跨切点',
        trigger: 'time',
        atMs: 3500,
        once: true,
        effects: [{ kind: 'addVariable', variableId: 'trust', value: 5 }],
      },
    ];
    expect(sceneDuration(p, s)).toBe(7000);
    expect(videoAt(s, 2999)).toMatchObject({ clip: { id: 'a' }, sourceMs: 3999 });
    expect(videoAt(s, 3000)).toMatchObject({ clip: { id: 'b' }, startMs: 3000, sourceMs: 2000 });
    let state = advance(p, start(p), 3600);
    expect(state.phase).toBe('playing');
    expect(state.variables.trust).toBe(35);
    state = loadGame(p, saveGame(p, state));
    expect(videoAt(s, state.positionMs)?.sourceMs).toBe(2600);
    expect(advance(p, state, 4000).variables.trust).toBe(35);
    expect(advance(p, state, 6500).phase).toBe('choosing');
    expect(prepareGameProject(p).scenes[0].timeline).toEqual(s.timeline);
  });
  it('loops only the trimmed BGM region, with node-relative offset and an explicit end', () => {
    const clip = {
      id: 'music',
      assetId: 'bgm',
      trimStartMs: 1000,
      trimEndMs: 3000,
      startMs: 500,
      durationMs: 6000,
      loop: true,
      volume: 0.25,
    };
    expect(audioSourceMs(clip, 499)).toBeUndefined();
    expect(audioSourceMs(clip, 500)).toBe(1000);
    expect(audioSourceMs(clip, 2500)).toBe(1000);
    expect(audioSourceMs(clip, 6499)).toBe(2999);
    expect(audioSourceMs(clip, 6500)).toBeUndefined();
    expect(audioSourceMs({ ...clip, loop: false }, 2500)).toBeUndefined();
    const p = fixture();
    const s = p.scenes[0];
    const clipId = editTimeline(p, s.id, { action: 'add', track: 'audio', assetId: 'bgm' });
    editTimeline(p, s.id, { action: 'update_audio', clipId, patch: { loop: true, volume: 0.2 } });
    editTimeline(p, s.id, { action: 'update_audio', clipId, patch: { durationMs: 12000 } });
    expect(s.timeline!.audioClips[0]).toMatchObject({ loop: true, volume: 0.2, durationMs: 12000 });
  });
  it('rejects invalid trims and media types atomically, and diagnoses imported invalid references and duplicate IDs', () => {
    const p = fixture();
    const s = p.scenes[0];
    const clipId = editTimeline(p, s.id, {
      action: 'add',
      track: 'video',
      assetId: 'asset_secondary',
    });
    const before = structuredClone(p);
    expect(() =>
      editTimeline(p, s.id, { action: 'update_video', clipId, patch: { trimStartMs: 90000 } }),
    ).toThrow('入点');
    expect(() =>
      editTimeline(p, s.id, { action: 'add', track: 'audio', assetId: 'asset_primary' }),
    ).toThrow();
    expect(p).toEqual(before);
    s.timeline!.videoClips[1].assetId = 'missing';
    s.timeline!.videoClips[1].id = s.timeline!.videoClips[0].id;
    const errors = validateProject(p).filter((i) => i.severity === 'error');
    expect(errors.some((i) => i.message.includes('类型错误'))).toBe(true);
    expect(errors.some((i) => i.message.includes('重复 ID'))).toBe(true);
  });
  it('applies an entire draft once, detects edit/undo conflicts and remaps copied clip IDs', () => {
    const p = fixture();
    useEditor.getState().load(p);
    const base = useEditor.getState().project;
    const serial = useEditor.getState().changeSerial;
    const next = structuredClone(p);
    editTimeline(next, p.scenes[0].id, { action: 'add', track: 'audio', assetId: 'bgm' });
    editTimeline(next, p.scenes[0].id, {
      action: 'add',
      track: 'video',
      assetId: 'asset_secondary',
    });
    expect(commitAgentTransaction(base, next, [], serial)).toBe(true);
    expect(useEditor.getState().past).toHaveLength(1);
    expect(webAssetPaths(next)).toContain('assets/music.wav');
    useEditor.getState().duplicate([p.scenes[0].id]);
    expect(
      validateProject(useEditor.getState().project).some((i) => i.message.includes('重复 ID')),
    ).toBe(false);
    useEditor.getState().undo();
    useEditor.getState().undo();
    expect(useEditor.getState().project).toEqual({
      ...base,
      revision: base.revision + 4,
      updatedAt: expect.any(String),
    });
    expect(commitAgentTransaction(base, next, [], serial)).toBe(false);
    expect(nodeDuration(p, p.scenes[0])).toBe(p.assets[0].durationMs);
  });
  it('adds audio to a legacy still without changing its duration or losing the image on export', () => {
    const p = fixture();
    const s = p.scenes[0];
    const image = {
      ...p.assets[0],
      id: 'still',
      type: 'image' as const,
      path: 'assets/still.jpg',
      durationMs: 0,
      builtin: false,
    };
    p.assets.push(image);
    s.assetId = image.id;
    s.durationMs = 9000;
    s.trimStartMs = 500;
    s.trimEndMs = 8500;
    const duration = nodeDuration(p, s);
    expect(editableTimeline(p, s)).toEqual({
      stillAssetId: image.id,
      videoClips: [],
      audioClips: [],
    });
    expect(s.timeline).toBeUndefined();
    const audio = editTimeline(p, s.id, { action: 'add', track: 'audio', assetId: 'bgm' });
    expect(s.assetId).toBe(image.id);
    expect(s.timeline?.audioClips[0].id).toBe(audio);
    expect(nodeDuration(p, s)).toBe(duration);
    expect(() =>
      editTimeline(p, s.id, { action: 'add', track: 'video', assetId: p.assets[0].id }),
    ).toThrow('移除静态画面');
    expect(() => editTimeline(p, s.id, { action: 'set_still', assetId: 'bgm' })).toThrow('图片');
    const exported = parseProject(prepareGameProject(p));
    expect(exported.scenes[0].assetId).toBe(image.id);
    expect(exported.scenes[0].timeline).toEqual(s.timeline);
    expect(webAssetPaths(exported)).toContain(image.path);
    expect(webAssetPaths(exported)).toContain('assets/music.wav');
    expect(sceneDuration(exported, exported.scenes[0])).toBe(duration);
  });
  it('splits a video at its source position without shifting node timing or music', () => {
    const p = fixture();
    const s = p.scenes[0];
    editTimeline(p, s.id, { action: 'add', track: 'audio', assetId: 'bgm' });
    const clip = s.timeline!.videoClips[0];
    const before = structuredClone(s.timeline!.audioClips);
    const rightId = editTimeline(p, s.id, {
      action: 'split_video',
      clipId: clip.id,
      sourceMs: 3500,
    });
    expect(s.timeline!.videoClips.map((c) => [c.trimStartMs, c.trimEndMs])).toEqual([
      [0, 3500],
      [3500, 9000],
    ]);
    expect(s.timeline!.videoClips[1].id).toBe(rightId);
    expect(nodeDuration(p, s)).toBe(9000);
    expect(s.timeline!.audioClips).toEqual(before);
    expect(() =>
      editTimeline(p, s.id, { action: 'split_video', clipId: rightId, sourceMs: 3500 }),
    ).toThrow('内部');
  });
});
describe('timeline Agent tools', () => {
  it('sorts picture batches naturally, paginates their IDs and aligns to dialogue through shared tools', () => {
    const project = fixture();
    const node = project.scenes[0];
    node.assetId = undefined;
    for (const number of [10, 2]) {
      project.assets.push({
        ...project.assets[0],
        id: `shot-${number}`,
        name: `shot-${number}.jpg`,
        path: `assets/shot-${number}.jpg`,
        type: 'image',
        durationMs: 0,
      });
    }
    const context: ToolContext = {
      project,
      selectedIds: [node.id],
      activeChapterId: null,
      intents: [],
    };
    const registry = createEditorTools();
    const run = (name: string, args: object) =>
      registry.execute(name, JSON.stringify({ nodeId: node.id, ...args }), context);
    const edit = (command: object) => run('edit_timeline', { command });
    expect(edit({ action: 'add_stills', assetIds: ['shot-10', 'shot-2'] }).data).toMatchObject({
      durationMs: 6000,
      stillCount: 2,
    });
    const current = () => context.project.scenes[0];
    const first = stillClipsFor(context.project, current())[0];
    expect(run('read_story', { action: 'timeline', track: 'still', limit: 1 }).data).toMatchObject({
      clips: [{ id: first.id, assetId: 'shot-2' }],
      truncated: true,
    });
    expect(
      run('read_story', { action: 'timeline', track: 'still', query: 'shot-10' }).data,
    ).toMatchObject({
      clips: [{ assetId: 'shot-10' }],
      truncated: false,
    });
    const before = structuredClone(context.project);
    expect(edit({ action: 'add_stills', assetIds: ['shot-2', 'bgm'] }).ok).toBe(false);
    expect(context.project).toEqual(before);
    expect(edit({ action: 'move', clipId: first.id, index: 1 }).ok).toBe(true);
    expect(
      edit({
        action: 'update_still',
        clipId: first.id,
        patch: { durationMs: 1000, dissolveMs: 200 },
      }).ok,
    ).toBe(true);
    expect(edit({ action: 'add', track: 'audio', assetId: 'bgm', role: 'dialogue' }).ok).toBe(true);
    const voice = current().timeline!.audioClips[0];
    expect(edit({ action: 'update_audio', clipId: voice.id, patch: { startMs: 1000 } }).ok).toBe(
      true,
    );
    expect(edit({ action: 'add', track: 'audio', assetId: 'bgm', role: 'music' }).ok).toBe(true);
    const music = current().timeline!.audioClips[1];
    expect(edit({ action: 'update_audio', clipId: music.id, patch: { startMs: 2000 } }).ok).toBe(
      true,
    );
    const audioClips = structuredClone(current().timeline!.audioClips);
    current().choicesAtMs = 3800;
    expect(edit({ action: 'align_stills_to_dialogue' }).data).toMatchObject({
      durationMs: 5000,
      dialogueEndMs: 5000,
      stillCount: 2,
    });
    expect(stillClipsFor(context.project, current()).map((clip) => clip.durationMs)).toEqual([
      3750, 1250,
    ]);
    expect(current().timeline!.audioClips).toEqual(audioClips);
    expect(current().choicesAtMs).toBe(3800);
    expect(validateProject(context.project)).toContainEqual({
      nodeId: node.id,
      severity: 'warning',
      message: '选项会在配音结束前出现。',
    });
    const exported = parseProject(prepareGameProject(context.project));
    const frames = stillClipsFor(exported, exported.scenes[0]);
    expect(exported.scenes[0].assetId).toBe('shot-10');
    expect(webAssetPaths(exported)).toEqual(
      expect.arrayContaining(['assets/shot-2.jpg', 'assets/shot-10.jpg']),
    );
    expect(stillAt(frames, 3850)).toMatchObject({
      clip: { id: first.id },
      previous: { assetId: 'shot-10' },
      mix: 0.5,
    });
    expect(stillAt(frames, 3950)?.previous).toBeUndefined();
    const saved = saveGame(exported, advance(exported, start(exported), 3800));
    const restored = loadGame(exported, saved);
    expect(stillAt(frames, restored.positionMs)).toMatchObject({
      clip: { id: first.id },
      mix: 0.25,
    });
  });
  it('sets and reads an independent still and audio track with the existing tools', () => {
    const project = fixture();
    const node = project.scenes[0];
    node.assetId = undefined;
    project.assets.push({
      ...project.assets[0],
      id: 'still',
      type: 'image',
      path: 'assets/still.jpg',
      durationMs: 0,
    });
    const context: ToolContext = {
      project,
      selectedIds: [node.id],
      activeChapterId: null,
      intents: [],
    };
    const registry = createEditorTools();
    const execute = (name: string, args: object) =>
      registry.execute(name, JSON.stringify({ nodeId: node.id, ...args }), context);
    expect(
      execute('edit_timeline', {
        command: { action: 'set_still', assetId: 'still', durationMs: 7500 },
      }),
    ).toMatchObject({
      ok: true,
      data: { stillAssetId: 'still', durationMs: 7500, videoCount: 0 },
    });
    expect(
      execute('edit_timeline', { command: { action: 'add', track: 'audio', assetId: 'bgm' } }).ok,
    ).toBe(true);
    expect(execute('read_story', { action: 'timeline', track: 'audio' }).data).toMatchObject({
      stillAssetId: 'still',
      durationMs: 7500,
      clips: [{ assetId: 'bgm' }],
    });
    expect(execute('edit_timeline', { command: { action: 'set_still', assetId: null } }).ok).toBe(
      true,
    );
    expect(context.project.scenes[0].assetId).toBeUndefined();
    expect(context.project.scenes[0].timeline?.audioClips).toHaveLength(1);
  });
  it('lets the Agent edit and retrieve audio fades through the shared schema', () => {
    const registry = createEditorTools();
    const c: ToolContext = {
      project: fixture(),
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      intents: [],
    };
    const run = (name: string, args: unknown) => registry.execute(name, JSON.stringify(args), c);
    const added = run('edit_timeline', {
      nodeId: 'scene_intro',
      command: { action: 'add', track: 'audio', assetId: 'bgm' },
    });
    const clipId = (added.data as { clipId: string }).clipId;
    expect(
      run('edit_timeline', {
        nodeId: 'scene_intro',
        command: { action: 'update_audio', clipId, patch: { fadeInMs: 800, fadeOutMs: 1200 } },
      }).ok,
    ).toBe(true);
    expect(
      run('read_story', { action: 'timeline', nodeId: 'scene_intro', track: 'audio' }).data,
    ).toMatchObject({
      clips: [{ fadeInMs: 800, fadeOutMs: 1200 }],
    });
    const before = structuredClone(c.project);
    expect(
      run('edit_timeline', {
        nodeId: 'scene_intro',
        command: { action: 'update_audio', clipId, patch: { fadeOutMs: -1 } },
      }).ok,
    ).toBe(false);
    expect(c.project).toEqual(before);
  });
  it('publishes schemas, paginates with truncation and rolls back failed commands', () => {
    const registry = createEditorTools();
    expect(registry.specs().find((t) => t.name === 'edit_timeline')?.parameters).toMatchObject({
      type: 'object',
    });
    const c: ToolContext = {
      project: fixture(),
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      intents: [],
    };
    const run = (name: string, args: unknown) => registry.execute(name, JSON.stringify(args), c);
    const added = run('edit_timeline', {
      nodeId: 'scene_intro',
      command: { action: 'add', track: 'video', assetId: 'asset_secondary' },
    });
    expect(added.ok).toBe(true);
    const page = run('read_story', {
      action: 'timeline',
      nodeId: 'scene_intro',
      track: 'video',
      limit: 1,
    });
    expect(page.data).toMatchObject({ total: 2, offset: 0, truncated: true });
    const second = run('read_story', {
      action: 'timeline',
      nodeId: 'scene_intro',
      track: 'video',
      offset: 1,
      limit: 1,
    });
    expect(second.data).toMatchObject({
      truncated: false,
      clips: [{ assetId: 'asset_secondary' }],
    });
    const before = structuredClone(c.project);
    expect(
      run('edit_timeline', {
        nodeId: 'scene_intro',
        command: {
          action: 'update_video',
          clipId: (added.data as { clipId: string }).clipId,
          patch: { trimEndMs: 90000 },
        },
      }).ok,
    ).toBe(false);
    expect(c.project).toEqual(before);
    expect(
      run('edit_scene', {
        action: 'update',
        args: { nodeId: 'scene_intro', patch: { assetId: 'asset_tertiary' } },
      }).ok,
    ).toBe(false);
    expect(
      run('read_story', { action: 'read', args: { nodeId: 'scene_intro' } }).data,
    ).toMatchObject({
      timeline: { videoCount: 2, audioCount: 0, retrieval: 'read_story.timeline' },
    });
    const metadataBefore = structuredClone(c.project.scenes[0]);
    expect(
      run('edit_scene', {
        action: 'update',
        args: { nodeId: 'scene_intro', patch: { title: '时间线节点改名' } },
      }).ok,
    ).toBe(true);
    expect(c.project.scenes[0]).toEqual({ ...metadataBefore, title: '时间线节点改名' });
  });
  it('runs multiple timeline edits through the real loop and commits once', async () => {
    const project = fixture();
    let round = 0;
    const commit = vi.fn(() => true);
    const result = await runAgent({
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      session: newSession(project.id),
      user: '给当前节点添加视频和配乐',
      provider: 'deepseek',
      model: 'fake',
      registry: createEditorTools(),
      signal: new AbortController().signal,
      runId: 'timeline_run',
      commit,
      onEvent: vi.fn(),
      client: async () =>
        round++ === 0
          ? {
              text: '',
              finish: 'complete',
              raw: {},
              calls: [
                {
                  id: 'one',
                  name: 'edit_timeline',
                  arguments: JSON.stringify({
                    nodeId: 'scene_intro',
                    command: { action: 'add', track: 'video', assetId: 'asset_secondary' },
                  }),
                },
                {
                  id: 'two',
                  name: 'edit_timeline',
                  arguments: JSON.stringify({
                    nodeId: 'scene_intro',
                    command: { action: 'add', track: 'audio', assetId: 'bgm' },
                  }),
                },
              ],
            }
          : { text: '已添加视频与配乐', calls: [], raw: {}, finish: 'complete' },
    });
    expect(result.turn.committed).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(project.scenes[0].timeline).toBeUndefined();
  });
});
