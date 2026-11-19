import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentSkillRuns, AgentSkillService } from '../../desktop/agent-skills';
import { AgentModelService } from '../../desktop/agent-model';
import { AgentSettingsService } from '../../desktop/agent-settings';
import { runAgent } from '../fixtures/agent-intent';
import { createEditorTools } from '../../packages/agent/tools';
import type { SkillRead } from '../../packages/agent/skills';
import { newSession } from '../../packages/agent/types';
import { testProject } from '../fixtures/project';

let root: string;
it('loads node and image skills before the first planning request', async () => {
  const project = testProject();
  const names = ['frameforge-node-storyboard', 'frameforge-storyboard-prompts'];
  const catalog = names.map((name) => ({
    name,
    description: '本地测试技能',
    digest: 'a'.repeat(64),
  }));
  const read = vi.fn(async (input: SkillRead) => {
    if (input.action !== 'open') throw new Error('Expected an automatic open');
    const identity = catalog.find(({ name }) => name === input.name)!;
    return {
      identity,
      text: `测试正文 ${identity.name}`,
      file: 'SKILL.md',
      total: 1,
      nextOffset: null,
      truncated: false,
    };
  });
  const result = await runAgent({
    project,
    session: newSession(project.id),
    user: '清理当前节点的分镜和提示词，然后重新进行整体设计和制作',
    provider: 'deepseek',
    model: 'test',
    selectedIds: [project.startNodeId],
    activeChapterId: null,
    runId: 'auto-shot-skills',
    signal: new AbortController().signal,
    registry: createEditorTools(),
    skills: { catalog, read },
    useRealPlan: true,
    commit: () => true,
    onEvent: () => {},
    client: async ({ system, tools, messages }) => {
      if (!tools.length) {
        expect(JSON.parse(messages[0].content).request).toBe(
          '清理当前节点的分镜和提示词，然后重新进行整体设计和制作',
        );
        return {
          text: JSON.stringify({ kind: 'execute', skills: names }),
          calls: [],
          raw: {},
          finish: 'complete',
        };
      }
      for (const name of names) expect(system).toContain(`测试正文 ${name}`);
      expect(system).toContain('画面提示词和尾帧提示词默认用中文');
      return { text: '已经读取本次规划所需的技能。', calls: [], raw: {}, finish: 'complete' };
    },
  });
  expect(result.turn.skills?.map(({ name }) => name)).toEqual(names);
  expect(result.turn.traces.filter(({ name }) => name === 'read_skill')).toHaveLength(2);
  expect(read).toHaveBeenCalledTimes(2);
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-skills-test-'));
});
afterEach(async () => {
  if (
    path.dirname(root) === os.tmpdir() &&
    path.basename(root).startsWith('frameforge-skills-test-')
  )
    await fs.rm(root, { recursive: true, force: true });
});

async function install(parent: string, name: string, description: string, body: string) {
  const dir = path.join(parent, name);
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${body}`,
  );
  return dir;
}

it('discovers local folders, keeps duplicate priority on refresh, and confines paginated reads to a frozen snapshot', async () => {
  const library = path.join(root, 'library');
  const name = 'short-drama-storyboard';
  const dir = await install(
    path.join(library, 'repo', 'skills'),
    name,
    '分镜规则',
    '镜'.repeat(6200),
  );
  const service = new AgentSkillService(path.join(root, 'app'));
  const catalog = await service.refresh(library);
  expect(catalog.skills.map((skill) => skill.name)).toEqual([name]);
  expect((await new AgentSkillService(path.join(root, 'app')).current()).catalog.root).toBe(
    library,
  );
  const runs = new AgentSkillRuns(service);
  const [frozen] = await runs.begin('run_first');
  const first = await runs.read('run_first', { action: 'open', name });
  expect(first).toMatchObject({
    nextOffset: 4800,
    truncated: true,
    identity: { digest: frozen.digest },
  });
  expect(
    (await runs.read('run_first', { action: 'open', name, offset: first.nextOffset })).truncated,
  ).toBe(false);
  await fs.writeFile(path.join(root, 'outside.md'), 'outside');
  await fs.link(path.join(root, 'outside.md'), path.join(dir, 'references', 'external.py'));
  await expect(
    runs.read('run_first', { action: 'read_file', name, file: '../outside.md' }),
  ).rejects.toThrow('没有');
  await expect(
    runs.read('run_first', { action: 'read_file', name, file: 'references/missing.md' }),
  ).rejects.toThrow('没有');
  await install(library, name, '同名技能', '不应替换现有版本');
  await install(path.join(library, 'repo', 'skills'), name, '分镜规则', '更新内容');
  const refreshed = await service.refresh();
  expect(refreshed.issues.join('\n')).toContain('技能同名');
  expect(refreshed.skills[0].directory).toBe(dir);
  expect(
    (await new AgentSkillService(path.join(root, 'app')).current()).catalog.skills[0].directory,
  ).toBe(dir);
  expect((await runs.read('run_first', { action: 'open', name })).text).toBe(first.text);
  const [next] = await runs.begin('run_second');
  expect(next.digest).not.toBe(frozen.digest);
  await expect(
    runs.read('run_second', { action: 'read_file', name, file: 'references/external.py' }),
  ).rejects.toThrow('没有');
  runs.cancelAll();
  await expect(runs.read('run_first', { action: 'open', name })).rejects.toThrow('已结束');
});

it('reads selected files for the same skill in one call and reports missing files separately', async () => {
  const name = 'frameforge-outline';
  const dir = await install(path.join(root, 'skills'), name, '大纲', '正文');
  await fs.writeFile(path.join(dir, 'references', 'guide.md'), '步骤'.repeat(3000));
  const runs = new AgentSkillRuns(new AgentSkillService(root));
  const run = 'run_batch_skill';
  const catalog = await runs.begin(run);
  const project = testProject();
  const read = vi.fn((input) => runs.read(run, input));
  const result = await createEditorTools().executeAsync(
    'read_skill_files',
    JSON.stringify({
      name,
      files: [
        { file: 'SKILL.md' },
        { file: 'references/guide.md' },
        { file: 'references/guide.md', offset: 0 },
        { file: 'references/missing.md' },
      ],
    }),
    { project, selectedIds: [], activeChapterId: null, intents: [], skills: { catalog, read } },
  );
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    results: [
      { file: 'SKILL.md', ok: true, nextOffset: null },
      { file: 'references/guide.md', ok: true, nextOffset: 4800 },
      { file: 'references/missing.md', ok: false },
    ],
  });
  expect(read).toHaveBeenCalledTimes(3);
});

it.each(['minimax', 'deepseek'] as const)(
  'runs the %s tool loop from skill discovery through Seedance reference and prompt delivery',
  async (provider) => {
    const library = path.join(root, 'skills');
    const storyboard = 'short-drama-storyboard';
    const video = 'short-drama-video-prompts';
    await install(library, storyboard, '拆分镜头和关键帧', '逐镜写起点、唯一动作、终点。');
    const dir = await install(
      library,
      video,
      '编写视频提示词',
      '读取 references/seedance-2.5.md。',
    );
    await fs.writeFile(
      path.join(dir, 'references', 'seedance-2.5.md'),
      '本镜时间轴，绑定真实参考图。',
    );
    const runs = new AgentSkillRuns(new AgentSkillService(root));
    const runId = `run_${provider}`;
    const catalog = await runs.begin(runId);
    const settings = new AgentSettingsService(
      root,
      {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('unexpected encryption');
        },
        decryptString: () => {
          throw new Error('unexpected decryption');
        },
      },
      { MINIMAX_API_KEY: 'local-test-key', DEEPSEEK_API_KEY: 'local-test-key' },
    );
    const calls = [
      ['read_skill', { action: 'open', name: storyboard }],
      ['read_skill', { action: 'open', name: video }],
      ['read_skill', { action: 'read_file', name: video, file: 'references/seedance-2.5.md' }],
      [
        'read_skill',
        { action: 'read_file', name: video, file: 'references/seedance-2.5.md', offset: 0 },
      ],
      ['read_story', { action: 'read', nodeId: 'scene_consume', section: 'storyboard' }],
    ] as const;
    let step = 0;
    const model = new AgentModelService(settings, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.messages[0].content).toContain(storyboard);
      if (calls[step]?.[0] === 'read_skill') {
        expect(body.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              function: expect.objectContaining({ name: 'read_skill' }),
            }),
          ]),
        );
      }
      if (step > 0) {
        if (provider === 'minimax')
          expect(body.messages.at(-2).reasoning_content).toBe('private-frame');
        const result = JSON.parse(body.messages.at(-1).content);
        expect(result.ok).toBe(true);
        if (step === 3) expect(result.data.text).toContain('绑定真实参考图');
        if (step === 4) {
          expect(result.summary).toContain('复用先前内容');
          expect(result.data).toBeUndefined();
        }
      }
      const next = calls[step++];
      return Response.json({
        choices: [
          {
            finish_reason: next ? 'tool_calls' : 'stop',
            message: next
              ? {
                  role: 'assistant',
                  content: null,
                  ...(provider === 'minimax' ? { reasoning_content: 'private-frame' } : {}),
                  tool_calls: [
                    {
                      id: `call_${step}`,
                      type: 'function',
                      function: {
                        name: next[0],
                        arguments: JSON.stringify(next[1]),
                      },
                    },
                  ],
                }
              : { role: 'assistant', content: '逐镜 Seedance 提示词已交付。' },
          },
        ],
      });
    });
    const project = testProject();
    const commit = vi.fn(() => true);
    const read = vi.fn((input) => runs.read(runId, input));
    const result = await runAgent({
      session: newSession(project.id),
      user: '把当前节点拆成 6 镜，写 Seedance 2.5 视频提示词',
      provider,
      model: (await settings.resolveModel(provider)).config.model,
      project,
      selectedIds: ['scene_consume'],
      activeChapterId: null,
      runId,
      signal: new AbortController().signal,
      registry: createEditorTools(),
      client: (request) => model.complete(request),
      skills: { catalog, read },
      commit,
      onEvent: () => {},
    });
    expect(result.turn.status, result.turn.error).toBe('completed');
    expect(result.turn.skills?.map(({ name }) => name)).toEqual([storyboard, video]);
    expect(result.turn.traces).toHaveLength(calls.length);
    expect(read).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result.session)).not.toContain('private-frame');
    expect(commit).not.toHaveBeenCalled();
    model.cancel(runId);
    runs.cancelAll();
  },
);

it('loads the workspace versions of the screenplay and shot skills through the desktop catalog', async () => {
  const service = new AgentSkillService(root, path.resolve('skills'));
  await service.refresh();
  const runs = new AgentSkillRuns(service);
  const runId = 'run_workspace_workflow';
  const catalog = await runs.begin(runId);
  for (const [name, fragment] of [
    ['frameforge-story-outline', '大纲负责全剧结构'],
    ['frameforge-chapter-planning', '逐句台词交给蓝图后的节点剧本正文'],
    ['frameforge-node-screenplay', '用 `edit_screenplay` 逐节点保存完整'],
    ['frameforge-chapter-blueprint', '已知与持有'],
    ['frameforge-node-storyboard', '读完当前版本的动作、对白、独白和声音'],
    ['frameforge-storyboard-prompts', 'append_shot_frame'],
    ['frameforge-video-prompts', '制作镜头卡'],
    ['frameforge-script-review', '选择前的依据'],
  ]) {
    expect(catalog.some((skill) => skill.name === name)).toBe(true);
    const result = await runs.read(runId, { action: 'open', name });
    expect(result).toMatchObject({ text: expect.stringContaining(fragment) });
  }
  const preview = await runs.preview({ action: 'open', name: 'frameforge-script-review' });
  expect(preview).toMatchObject({
    identity: { name: 'frameforge-script-review' },
    file: 'SKILL.md',
    text: expect.stringContaining('选择前的依据'),
  });
  await expect(
    runs.preview({ action: 'read_file', name: 'frameforge-script-review', file: '../other' }),
  ).rejects.toThrow('只能预览');
  runs.cancel(runId);
});
