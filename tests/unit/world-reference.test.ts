import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentSettingsService } from '../../desktop/agent-settings';
import { AgentModelService } from '../../desktop/agent-model';
import {
  WorldReferenceService,
  referencePrompt,
  shotImagePrompt,
} from '../../desktop/world-reference';
import { WorldReferenceQueue } from '../../desktop/world-reference-queue';
import { loopingAmbientWav } from '../../desktop/looping-wav';
import { makeProject } from '../../packages/domain/schema';
import { resolveProjectArtStyle } from '../../packages/domain/art-style';
import { generateMiniMaxImage } from '../../desktop/minimax-image';
import { voicePreviewWav } from '../fixtures/voice-preview';

vi.mock('electron', () => ({ nativeImage: {} }));

it('sends the dry-voice and ambient-sound prompts to Seed Audio and stores their WAVs in the active project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-world-reference-'));
  try {
    const project = makeProject();
    const scope = { project, root, registerGeneratedAsset: vi.fn(), asset: vi.fn() };
    const audio = voicePreviewWav();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ audio, duration: 0.1 }));
    const settings = new AgentSettingsService(
      root,
      {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('not used');
        },
        decryptString: () => {
          throw new Error('not used');
        },
      },
      { DOUBAO_TTS_API_KEY: 'fixture-key', OPENAI_API_KEY: 'fixture-text-key' },
      request,
    );
    const modelResponse = (text: string) =>
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      });
    const modelRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(modelResponse('22'))
      .mockResolvedValueOnce(modelResponse('39'))
      .mockResolvedValueOnce(modelResponse('99'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementation(async () => modelResponse('30'));
    const model = new AgentModelService(settings, modelRequest);
    const service = new WorldReferenceService(scope, settings, undefined, model);
    const generate = (
      settingKind: 'character' | 'location',
      name: string,
      description: string,
      characterProfile?: string,
    ) =>
      service.generate({
        projectId: project.id,
        requestId: randomUUID(),
        reference: { kind: 'audio', settingKind, name, description, characterProfile },
      });
    const voice = await generate('character', '林远', '低沉，语速慢', '沉稳的管理员');
    const ambient = await generate('location', '空站台', '风吹过木栅栏');
    expect(modelRequest).toHaveBeenCalledTimes(1);
    const selection = JSON.parse(String(modelRequest.mock.calls[0][1]?.body));
    expect(selection.tools).toEqual([]);
    expect(JSON.parse(selection.input[0].content)).toEqual({
      name: '林远',
      profile: '沉稳的管理员',
      voice: '低沉，语速慢',
    });
    await generate('character', '唐宁', '活泼，语速快');
    await generate('character', '越界测试', '声音平稳');
    await generate('character', '服务故障测试', '声音平稳');
    const payloads = request.mock.calls.map(([url, init], index) => {
      expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/create');
      expect(init?.headers).toMatchObject({ 'X-Api-Key': 'fixture-key' });
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        model: 'seed-audio-1.0',
        audio_config: { format: 'wav', sample_rate: 24000 },
      });
      expect(payload.audio_config.speech_rate).toBe([22, undefined, 39, 30, 30][index]);
      return payload.text_prompt;
    });
    expect(payloads[0]).toContain('我是林远，我的声音是这样的。');
    expect(payloads[0]).toContain('语速由合成参数控制');
    expect(payloads[0]).not.toContain('沉稳的管理员');
    expect(payloads[0].split('逐字念出台词：')[1]).not.toContain('语速慢');
    expect(payloads[1]).toContain('无配乐、旁白或可辨识的台词');
    expect(payloads[1]).toContain('风吹过木栅栏');
    expect(payloads[1]).toContain('20 秒、可无缝循环');
    expect(voice).toMatchObject({ name: '林远 · 角色干声.wav', durationMs: 100, type: 'audio' });
    expect(ambient).toMatchObject({ name: '空站台 · 场景环境声.wav', durationMs: 20_000 });
    const loop = await fs.readFile(path.join(root, ambient.path));
    expect(loop.readUInt32LE(40) / loop.readUInt32LE(28)).toBe(20);
    expect(await fs.readFile(path.join(root, voice.path))).toEqual(Buffer.from(audio, 'base64'));
    expect(scope.registerGeneratedAsset).toHaveBeenCalledWith(root, voice);
    expect(project.assets).toEqual([]);

    request.mockResolvedValueOnce(Response.json({ code: 45001125 }, { status: 400 }));
    await expect(generate('character', '林远', '低声')).rejects.toThrow('试听文本审核');

    request.mockImplementationOnce(async () => {
      scope.project = makeProject();
      return Response.json({ audio });
    });
    await expect(generate('character', '林远', '低声')).rejects.toThrow('工程或保存位置已切换');
    expect(scope.registerGeneratedAsset).toHaveBeenCalledTimes(5);
  } finally {
    const actual = await fs.realpath(root);
    if (
      path.dirname(actual) === (await fs.realpath(os.tmpdir())) &&
      path.basename(actual).startsWith('frameforge-world-reference-')
    )
      await fs.rm(actual, { recursive: true, force: true });
  }
});

it('requests a gray four-view character sheet and applies the project art style at 3:2', () => {
  const character = referencePrompt({
    kind: 'image',
    settingKind: 'character',
    name: '林远',
    description: '蓝色外套',
    imagePrompt: '强调衣料纹理',
    artStyle: { preset: 'anime', description: '暖色线稿' },
    atmosphereTone: '低饱和钢灰，保留肤色与暖光。',
  });
  expect(character).toMatch(/灰色纯背景.*正面头肩特写.*正面全身.*侧面全身.*背面全身/);
  expect(character).toContain('横向 3:2');
  expect(character).toContain('二次元动画');
  expect(character).toContain('暖色线稿');
  expect(character).toContain('\n\n风格补充描述\n低饱和钢灰，保留肤色与暖光。');
  expect(character).toContain('绘图补充要求');
  expect(character).toContain('强调衣料纹理');
  const scene = referencePrompt({
    kind: 'image',
    settingKind: 'location',
    name: '空站台',
    description: '金色的夕阳',
  });
  expect(scene).toContain('广角构图');
  expect(scene).toContain('金色的夕阳');
  expect(scene).toContain('横向 3:2');
  expect(scene).not.toContain('风格补充描述');
});

it('uses the shot’s wardrobe and prop state over clothing in the character reference', () => {
  const prompt = shotImagePrompt({
    name: '病房中景',
    frame: 'first',
    aspect: 'landscape',
    references: [{ assetId: 'actor', name: '苏晚晴定妆照' }],
    prompt:
      '【取景与构图】病床侧面中景。\n【主体与状态】苏晚晴穿米白高领羊绒衫。雾霾蓝长大衣搭在椅背，手中是白色纸杯。',
  });
  expect(prompt).toContain('16:9');
  expect(prompt).toContain('雾霾蓝长大衣搭在椅背');
  expect(prompt).toContain('图1："苏晚晴定妆照"');
  expect(prompt).toContain('穿着和道具的位置与状态以本镜说明为准');
  expect(prompt).toContain('【取景与构图】病床侧面中景。\n【主体与状态】');
});

it('carries the combined project style into both reference and shot image prompts', () => {
  const artStyle = resolveProjectArtStyle({
    artStyle: { preset: 'realistic', description: '柔和的边缘光' },
    creativeDefaults: { visualStyle: '国漫3D高清渲染风' },
  });
  const reference = referencePrompt({
    kind: 'image',
    settingKind: 'character',
    name: '林远',
    description: '蓝色外套',
    artStyle,
  });
  const shot = shotImagePrompt({
    name: '出发',
    frame: 'first',
    aspect: 'landscape',
    references: [],
    prompt: '林远推开门。',
    artStyle,
  });
  for (const prompt of [reference, shot]) {
    expect(prompt).toContain('3D 动画');
    expect(prompt).toContain('国漫3D高清渲染风');
    expect(prompt).toContain('柔和的边缘光');
  }
});

it('runs image and audio together, starts each lane in order, and removes a canceled waiting job', async () => {
  const queue = new WorldReferenceQueue();
  const controller = new AbortController();
  const canceled = new AbortController();
  let finishFirst!: (value: string) => void;
  const first = new Promise<string>((resolve) => {
    finishFirst = resolve;
  });
  const status = vi.fn();
  const skipped = vi.fn(async () => 'skipped');
  const one = queue.run('image', controller.signal, status, () => first);
  const two = queue.run('image', canceled.signal, status, skipped);
  const three = queue.run('image', controller.signal, status, async () => 'third');
  const sound = queue.run('audio', controller.signal, status, async () => 'sound');
  await expect(sound).resolves.toBe('sound');
  expect(status.mock.calls).toEqual([['queued'], ['queued'], ['running'], ['running']]);
  const stopped = expect(two).rejects.toMatchObject({ name: 'AbortError' });
  canceled.abort();
  await stopped;
  finishFirst('first');
  await expect(one).resolves.toBe('first');
  await expect(three).resolves.toBe('third');
  expect(skipped).not.toHaveBeenCalled();
});

it('keeps the PCM samples continuous across the end-to-start boundary', () => {
  const wav = Buffer.from(voicePreviewWav(0.34), 'base64');
  for (let sample = 0; 44 + sample * 2 < wav.length; sample++)
    wav.writeInt16LE(sample * 2 - 8000, 44 + sample * 2);
  const loop = loopingAmbientWav(wav);
  const start = loop.readInt16LE(44);
  const end = loop.readInt16LE(loop.length - 2);
  expect(Math.abs(start - end)).toBeLessThan(10);
  expect(loop.readUInt32LE(40) / loop.readUInt32LE(28)).toBe(20);
});

it('uses separate MiniMax endpoints for text and two-reference requests without retrying errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-h3-image-'));
  const first = path.join(root, 'character.png');
  const second = path.join(root, 'room.jpg');
  try {
    await Promise.all([fs.writeFile(first, 'character'), fs.writeFile(second, 'room')]);
    const sample = Buffer.from('fake response image');
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        Response.json({ data: [{ b64_json: sample.toString('base64') }] }),
      )
      .mockImplementationOnce(async () =>
        Response.json({ data: [{ b64_json: sample.toString('base64') }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: '1002', message: 'secret' } }, { status: 429 }),
      );
    const signal = new AbortController().signal;
    await expect(
      generateMiniMaxImage(request, 'secret', '写实，横向 3:2', [], 1536, 1024, signal),
    ).resolves.toEqual(sample);
    await expect(
      generateMiniMaxImage(
        request,
        'secret',
        '水彩，图1角色、图2房间',
        [first, second],
        1080,
        1920,
        signal,
      ),
    ).resolves.toEqual(sample);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.minimax.cn/v1/images/generations',
      'https://api.minimax.cn/v1/images/edits',
    ]);
    const [text, edit] = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(text).toMatchObject({ model: 'MiniMax-H3-Image', size: '1536x1024', n: 1 });
    expect(text).not.toHaveProperty('images');
    expect(edit).toMatchObject({
      size: '1080x1920',
      prompt: '水彩，图1角色、图2房间',
      response_format: 'b64_json',
      images: [
        { image_url: 'data:image/png;base64,' + Buffer.from('character').toString('base64') },
        { image_url: 'data:image/jpeg;base64,' + Buffer.from('room').toString('base64') },
      ],
    });
    await expect(
      generateMiniMaxImage(request, 'secret', '写实', [], 1536, 1024, signal),
    ).rejects.toThrow('触发限流（HTTP 429，错误代码 1002）');
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    await fs.unlink(first).catch(() => {});
    await fs.unlink(second).catch(() => {});
    await fs.rmdir(root);
  }
});

it('starts five MiniMax images and queues the sixth until one finishes', async () => {
  const queue = new WorldReferenceQueue();
  const status = vi.fn();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = Array.from({ length: 5 }, () =>
    queue.run('minimax', new AbortController().signal, status, () => hold),
  );
  const sixth = queue.run('minimax', new AbortController().signal, status, async () => 6);
  await Promise.resolve();
  expect(status.mock.calls).toEqual([['queued'], ...Array.from({ length: 5 }, () => ['running'])]);
  release();
  await Promise.all(first);
  await expect(sixth).resolves.toBe(6);
  expect(status.mock.calls.at(-1)).toEqual(['running']);
});
