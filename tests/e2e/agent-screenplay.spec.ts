import { launchEditor } from './launch-editor';
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentSessionService } from '../../desktop/agent-sessions';
import { exists } from '../../desktop/files';
import {
  baseUrlSchema,
  providerConfigSchema,
  providerIdSchema,
} from '../../packages/agent/settings';
import { agentRunTimeoutMs, type AgentSession } from '../../packages/agent/types';
import { parseProject, type Project } from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
import { exploreStoryRoutes } from '../../packages/runtime/routes';
import { testWithWorkspace as test } from './workspace-fixture';

const prompt =
  '我想你写一个剧本 题材是一个宅男一觉醒来 发现自己养的两只猫变成了美少女  我希望情节轻松暧昧诱惑 人设封面 用第一视角写故事 故事跨越三天时间 创建可点击的选项、连到不同剧情、验收分支';

function inspectProject(project: Project) {
  const script = project.scenes
    .flatMap((scene) => [
      ...(scene.storyboardPages?.map(({ text }) => text) ?? []),
      scene.endingText,
    ])
    .filter(Boolean);
  const dayText = [
    ...project.chapters.map(({ title }) => title),
    ...project.scenes.map(({ title }) => title),
    ...script,
  ].join('\n');
  const days = ['一1', '二2', '三3'].map((number, index) =>
    new RegExp(`第\\s*[${number}]\\s*[天日]|(?:Day|D)\\s*${index + 1}\\b`, 'i').test(dayText),
  );
  const validationErrors = validateProject(project).filter(({ severity }) => severity === 'error');
  let branches: ReturnType<typeof exploreStoryRoutes> | undefined;
  let runtimeError: string | undefined;
  try {
    branches = exploreStoryRoutes(project);
  } catch (error) {
    runtimeError = String(error);
  }
  return {
    chapters: project.chapters.length,
    scenes: project.scenes.length,
    visibleScriptBlocks: script.length,
    firstPersonEvidence: script.some((text) => /我/.test(text)),
    dayMarkers: days,
    characterCount: project.worldSettings?.filter(({ kind }) => kind === 'character').length ?? 0,
    assetCount: project.assets.length,
    validationErrors,
    branches,
    runtimeError,
  };
}

test('live model creates and verifies a branching screenplay in a blank project', async ({
  testWorkspace: root,
}, testInfo) => {
  test.skip(
    !process.env.FRAMEFORGE_E2E_PROVIDER,
    'Opt in to a live model with FRAMEFORGE_E2E_PROVIDER.',
  );
  test.setTimeout(agentRunTimeoutMs + 2 * 60_000);
  const provider = providerIdSchema.parse(process.env.FRAMEFORGE_E2E_PROVIDER);
  const modelOverride = process.env.FRAMEFORGE_E2E_MODEL?.trim();
  const baseUrlOverride = baseUrlSchema.optional().parse(process.env.FRAMEFORGE_E2E_BASE_URL);
  const credentialSource = providerConfigSchema.shape.credentialSource
    .optional()
    .parse(process.env.FRAMEFORGE_E2E_CREDENTIAL_SOURCE);
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  if (process.env.APPDATA) {
    const localProfile = path.join(process.env.APPDATA, 'frameforge-studio');
    const localSettings = path.join(localProfile, 'agent-settings.json');
    if (await exists(localSettings)) {
      await fs.copyFile(localSettings, path.join(profile, 'agent-settings.json'));
      // Windows safeStorage needs the original encryption state to open the saved ciphertext.
      const localState = path.join(localProfile, 'Local State');
      if (await exists(localState)) {
        const { os_crypt } = JSON.parse(await fs.readFile(localState, 'utf8'));
        if (os_crypt)
          await fs.writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt }), {
            flag: 'wx',
          });
      }
    }
  }
  const env = { ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: profile };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
  const app = await launchEditor({ args: ['.'], env });
  const reportPath = testInfo.outputPath('agent-screenplay-report.json');
  const rendererErrors: string[] = [];
  const report: Record<string, unknown> = {
    provider,
    requestedModel: modelOverride,
    credentialSourceOverride: credentialSource,
    rendererErrors,
  };
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    await page.locator('.project-menu').click();
    await page.getByRole('menuitem', { name: '新建作品', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建作品', exact: true });
    await dialog.getByLabel('作品名称').fill('三天分支剧本验收');
    await dialog.getByRole('button', { name: '创建工程', exact: true }).click();
    await expect(dialog).toBeHidden();
    const recoveryFile = path.join(profile, 'recovery.json');
    const recover = async () => {
      const { project } = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
      return { project: parseProject(project) };
    };
    const initial = await recover();
    expect(initial.project.scenes).toHaveLength(1);
    expect(initial.project.assets).toHaveLength(0);
    const model = await page.evaluate(
      async ({ provider, modelOverride, credentialSource, baseUrlOverride }) => {
        const settings = await window.frameforge!.agentSettings.get();
        const config = settings.providers[provider];
        if (!modelOverride && !credentialSource && !baseUrlOverride) return config.model;
        const saved = await window.frameforge!.agentSettings.save({
          defaultProvider: settings.defaultProvider,
          providers: {
            ...settings.providers,
            [provider]: {
              ...config,
              model: modelOverride ?? config.model,
              baseUrl: baseUrlOverride ?? config.baseUrl,
              credentialSource: credentialSource ?? config.credentialSource,
            },
          },
        });
        return saved.providers[provider].model;
      },
      { provider, modelOverride, credentialSource, baseUrlOverride },
    );
    report.model = model;
    const selector = page.getByLabel('对话模型服务商', { exact: true });
    await selector.selectOption(provider);
    await expect(selector).toHaveAttribute('title', model);
    await page.getByLabel('向创作 Agent 发送消息', { exact: true }).fill(prompt);
    const started = Date.now();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();

    const sessions = new AgentSessionService(profile);
    let session: AgentSession | null = null;
    let progress = '';
    const observe = async () => {
      const [chat] = await sessions.list(initial.project.id);
      if (chat) session = await sessions.load(initial.project.id, chat.id);
      const turn = session?.turns.at(-1);
      if (!turn) return undefined;
      const failures = turn.traces.filter(({ status }) => status === 'error');
      const status = `${turn.status} · ${turn.traces.length} 次调用 · ${failures.length} 条工具错误`;
      if (status !== progress) console.log(`[${provider}/${model}] ${(progress = status)}`);
      Object.assign(report, {
        status: turn.status,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        committed: turn.committed,
        terminalError: turn.error,
        execution: turn.execution,
        checkpoint: session?.checkpoint
          ? {
              savedWrites: session.checkpoint.writes.length,
            }
          : null,
        toolCalls: turn.traces.map(({ name, status, durationMs, result }) => ({
          name,
          status,
          durationMs,
          ...(status === 'error' || ['check_story', 'read_batch'].includes(name)
            ? { summary: result?.summary }
            : {}),
        })),
      });
      return turn;
    };
    await expect
      .poll(async () => (await observe())?.status ?? 'starting', {
        intervals: [2000, 5000],
        timeout: agentRunTimeoutMs + 20_000,
      })
      .toMatch(/^(completed|error|conflict|stopped)$/);
    const turn = (await observe())!;
    if (turn.committed) {
      await expect
        .poll(async () => (await recover()).project.revision)
        .toBeGreaterThan(initial.project.revision);
    }
    const saved = await recover();
    const draft = (session as AgentSession | null)?.checkpoint?.draft;
    const inspected = inspectProject(turn.committed ? saved.project : (draft ?? saved.project));
    report.inspected = turn.committed ? 'committed' : draft ? 'checkpoint' : 'initial';
    report.project = inspected;
    expect(turn.provider).toBe(provider);
    expect(turn.model).toBe(model);
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.committed).toBe(true);
    expect(rendererErrors).toEqual([]);
    expect(inspected.validationErrors).toEqual([]);
    expect(inspected.firstPersonEvidence).toBe(true);
    expect(inspected.dayMarkers).toEqual([true, true, true]);
    expect(inspected.characterCount).toBeGreaterThanOrEqual(2);
    expect(inspected.assetCount).toBe(0);
    expect(inspected.branches, inspected.runtimeError).toMatchObject({
      distinctChoices: true,
      truncated: false,
      failures: [],
    });
    expect(inspected.branches?.endings).toBeGreaterThan(0);
    expect(
      turn.traces.some(({ name, status }) => status === 'done' && name === 'check_story'),
    ).toBe(true);
    report.accepted = true;
  } finally {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ accepted: false, ...report }, null, 2));
    console.log(`验收报告 ${reportPath}`);
    await app.close();
  }
});
