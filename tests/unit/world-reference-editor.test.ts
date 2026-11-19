import { expect, it, vi } from 'vitest';
import { makeProject, type Asset } from '../../packages/domain/schema';
import {
  createWorldSetting,
  type GenerateWorldReference,
} from '../../packages/domain/world-settings';
import { useEditor } from '../../src/store/editor';
import { useWorldReferences } from '../../src/store/world-reference';

const generation = vi.hoisted(() => vi.fn<GenerateWorldReference>());
const autosave = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/platform/world-reference', () => ({ generateWorldReference: generation }));
vi.mock('../../src/platform', () => ({ platform: { autosave } }));

it('commits parallel image and audio results to separate slots without overwriting intervening edits', async () => {
  const project = makeProject();
  const setting = createWorldSetting(project, 'character', {
    name: '林远',
    visual: '蓝色外套',
    sound: '中音',
  });
  useEditor.getState().load(project);
  const completions = new Map<string, (asset: Asset) => void>();
  generation.mockImplementation(
    (_id, request) =>
      new Promise((resolve) => {
        completions.set(request.kind, resolve);
      }),
  );
  const refs = useWorldReferences.getState();
  const image = refs.generate(setting.id, 'image', '生成参考图');
  const audio = refs.generate(setting.id, 'audio', '生成干声');
  expect(useWorldReferences.getState().jobs).toHaveLength(2);
  useEditor.getState().commit((draft) => {
    draft.title = '继续编辑后的标题';
  });
  const asset = (type: 'image' | 'audio'): Asset => ({
    id: `asset_${type}`,
    name: type,
    path: `assets/reference.${type === 'image' ? 'png' : 'wav'}`,
    type,
    durationMs: 0,
    size: 64,
    width: 0,
    height: 0,
    builtin: false,
  });
  completions.get('audio')!(asset('audio'));
  await audio;
  completions.get('image')!(asset('image'));
  await image;
  expect(useEditor.getState().project).toMatchObject({
    title: '继续编辑后的标题',
    worldSettings: [
      expect.objectContaining({ audioAssetId: 'asset_audio', imageAssetId: 'asset_image' }),
    ],
  });
  expect(autosave).toHaveBeenCalledTimes(2);
  expect(useWorldReferences.getState().jobs).toEqual([]);
});

it('removes unused generated images on replacement and keeps shared and imported images', async () => {
  const project = makeProject();
  const makeImage = (key: string, name = '林远 · 定妆参考图.png'): Asset => {
    const path = `assets/${key.repeat(24)}.png`;
    return {
      id: `asset_${key.repeat(24)}`,
      name,
      type: 'image',
      path,
      thumbnail: path,
      size: 64,
      durationMs: 0,
      width: 600,
      height: 400,
      builtin: false,
    };
  };
  const old = makeImage('a');
  const stale = makeImage('b');
  const shared = makeImage('c');
  const imported = makeImage('d', '原始素材.png');
  const other = makeImage('e', '车站 · 场景参考图.png');
  const fresh = makeImage('f');
  project.assets.push(old, stale, shared, imported, other);
  project.scenes[0].assetId = shared.id;
  const setting = createWorldSetting(project, 'character', {
    name: '林远',
    visual: '蓝色外套',
    imageAssetId: old.id,
  });
  useEditor.getState().load(project);
  generation.mockRejectedValueOnce(new Error('生成失败')).mockResolvedValueOnce(fresh);
  const refs = useWorldReferences.getState();
  await refs.generate(setting.id, 'image', '重新生成参考图');
  expect(useEditor.getState().project.assets).toEqual(project.assets);
  await refs.generate(setting.id, 'image', '重新生成参考图');
  expect(useEditor.getState().project.assets.map(({ id }) => id)).toEqual([
    shared.id,
    imported.id,
    other.id,
    fresh.id,
  ]);
  expect(useEditor.getState().project.worldSettings?.[0].imageAssetId).toBe(fresh.id);
  useEditor.getState().undo();
  expect(useEditor.getState().project.worldSettings?.[0].imageAssetId).toBe(old.id);
});
