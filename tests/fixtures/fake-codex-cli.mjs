import readline from 'node:readline';
import fs from 'node:fs';

const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'text';
const log = process.env.FAKE_CODEX_LOG;
const threadId = 'codex-test-thread';
let starts = 0;
let replies = 0;
let hasTools = false;
let hasScopeTool = false;
let toolNames = [];
let isRequestPlan = false;
const send = (message) => {
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  // Exercise UTF-8 decoding across native stdout chunk boundaries.
  const split = bytes.indexOf(Buffer.from('本')) + 1;
  if (split > 0) {
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
  } else process.stdout.write(bytes);
};
const finish = (text = '已完成本机创作。') => {
  send({
    method: 'item/completed',
    params: {
      threadId,
      item: {
        id: 'final',
        type: 'agentMessage',
        phase: 'final_answer',
        text,
      },
    },
  });
  // Keep line boundaries intact after the deliberately split UTF-8 message.
  setTimeout(
    () =>
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: 'turn-test', status: 'completed' },
        },
      }),
    15,
  );
};
const tool = (id) =>
  send({
    id: `rpc-${id}`,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId: 'turn-test',
      callId: `call-${id}`,
      namespace: null,
      tool: scenario === 'unknown-tool' ? 'exec_command' : 'edit_scene',
      arguments: {
        action: 'update',
        args: {
          nodeId: scenario === 'tool-error' && id === 1 ? 'missing-scene' : 'scene_intro',
          patch: { title: id === 1 ? 'CLI 第一处修改' : 'CLI 第二处修改' },
        },
      },
    },
  });
const storyboardTool = (name, args, id = name) =>
  send({
    id: `rpc-${id}`,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId: 'turn-test',
      callId: `call-${id}`,
      namespace: null,
      tool: name,
      arguments: args,
    },
  });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(message) + '\n');
  if (message.method === 'initialize') {
    if (scenario === 'bad-json') process.stdout.write('not-json SECRET\n');
    else if (scenario === 'rpc-error')
      send({ id: message.id, error: { code: -1, message: 'SECRET' } });
    else send({ id: message.id, result: { userAgent: 'fake-codex' } });
  } else if (message.method === 'account/read') {
    send({
      id: message.id,
      result: {
        account: scenario === 'logged-out' ? null : { type: 'chatgpt' },
        requiresOpenaiAuth: true,
      },
    });
  } else if (message.method === 'model/list') {
    const firstPage = !message.params.cursor;
    send({
      id: message.id,
      result: {
        data: firstPage
          ? [
              { id: 'catalog-id', model: 'fixture-fast', displayName: 'Fixture Fast' },
              { id: 'fixture-hidden', hidden: true },
            ]
          : [{ id: 'fixture-deep', displayName: 'Fixture Deep' }, { id: 'fixture-fast' }],
        nextCursor: firstPage ? 'next' : null,
      },
    });
  } else if (message.method === 'thread/start') {
    toolNames = message.params.dynamicTools?.map((tool) => tool.name) ?? [];
    hasScopeTool = message.params.dynamicTools?.some((tool) => tool.name === 'set_task_scope');
    hasTools = (message.params.dynamicTools?.length ?? 0) > 0;
    isRequestPlan = message.params.baseInstructions?.includes('只返回一个 JSON 对象');
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    starts++;
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    process.stderr.write('SECRET provider diagnostic\n');
    send({
      method: 'item/completed',
      params: { threadId, item: { type: 'reasoning', text: 'SECRET internal reasoning' } },
    });
    if (scenario === 'hang') return;
    if (scenario === 'multistage') {
      if (toolNames.includes('edit_story_design'))
        storyboardTool(
          'edit_story_design',
          { target: { stage: 'brief' }, text: '测试工程简报。' },
          'first-call',
        );
      else if (toolNames.includes('edit_screenplay'))
        storyboardTool(
          'edit_screenplay',
          { nodeId: 'scene_intro', blocks: [{ kind: 'action', text: '主角拆开来信。' }] },
          'first-call',
        );
      else finish('没有当前步骤需要的工具。');
      return;
    }
    if (isRequestPlan && ['storyboard', 'production-audio', 'tools'].includes(scenario)) {
      finish(
        JSON.stringify({
          kind: 'execute',
          ...(scenario === 'storyboard' && { externalActions: ['image'] }),
          ...(scenario === 'production-audio' && { externalActions: ['audio'] }),
        }),
      );
      return;
    }
    if (scenario === 'production-audio') {
      if (hasTools)
        storyboardTool('read_project', { action: 'assets', category: 'sound' }, 'reuse-sound');
      else
        finish(
          JSON.stringify({
            notes: [
              { startMs: 0, durationMs: 2000, wave: 'pad', hz: 110, gain: 0.45 },
              { startMs: 300, durationMs: 800, wave: 'pluck', hz: 164.81, gain: 0.25 },
            ],
          }),
        );
      return;
    }
    if (scenario === 'image' || (scenario === 'storyboard' && !hasTools)) {
      setTimeout(
        () => {
          send({
            method: 'item/completed',
            params: {
              threadId,
              item: {
                id: 'image-test',
                type: 'imageGeneration',
                status: 'completed',
                savedPath: process.env.FAKE_CODEX_IMAGE,
              },
            },
          });
          finish();
        },
        Number(process.env.FAKE_CODEX_IMAGE_DELAY_MS ?? 0),
      );
      return;
    }
    if (scenario === 'storyboard') {
      storyboardTool('edit_world_setting', {
        action: 'create',
        kind: 'location',
        name: '晨光森林',
        description: '一封来信引导主角进入这片常年无人踏足的森林。',
        visual:
          '清晨的阔叶林里，潮湿的落叶覆盖蜿蜒小径。灰褐色树干稀疏排列，树冠间漏下一束柔和金光照亮岩石上的信封，低处薄雾遮住远方。测试灌木颜色深绿，小径两侧生有细密的苔藓。',
      });
      return;
    }
    if (scenario === 'exit') process.exit(12);
    if (scenario === 'failed') {
      send({
        method: 'turn/completed',
        params: { threadId, turn: { status: 'failed', error: { message: 'SECRET' } } },
      });
    } else if (
      hasTools &&
      ['tools', 'parallel', 'unknown-tool', 'tool-error', 'tools-hang'].includes(scenario) &&
      starts === 1
    ) {
      if (hasScopeTool) {
        send({
          id: 'rpc-scope',
          method: 'item/tool/call',
          params: {
            threadId,
            turnId: 'turn-test',
            callId: 'call-scope',
            namespace: null,
            tool: 'set_task_scope',
            arguments: {
              action: 'start',
              policy: { mode: 'execute', target: { stage: 'outline' } },
            },
          },
        });
      } else {
        tool(1);
        if (scenario === 'parallel') tool(2);
      }
    } else finish();
  } else if (message.id === 'rpc-scope' && message.result?.success) {
    tool(1);
    if (scenario === 'parallel') tool(2);
  } else if (message.id?.toString().startsWith('rpc-') && message.result) {
    if (scenario === 'production-audio' && message.result.success) {
      const result = JSON.parse(message.result.contentItems[0].text).data;
      const timeline = (command, id) =>
        storyboardTool('edit_timeline', { nodeId: 'scene_intro', command }, id);
      if (message.id === 'rpc-reuse-sound') {
        timeline(
          { action: 'add', track: 'audio', assetId: result.assets[0].id, role: 'effect' },
          'add-sound',
        );
        return;
      }
      if (message.id === 'rpc-add-sound') {
        storyboardTool('generate_production_audio', {
          category: 'music',
          name: '低音悬念',
          prompt: '低音渐起的悬念铺底',
          durationMs: 2000,
        });
        return;
      }
      if (message.id === 'rpc-generate_production_audio') {
        timeline(
          { action: 'add', track: 'audio', assetId: result.assetId, role: 'music' },
          'add-music',
        );
        return;
      }
      if (message.id === 'rpc-add-music') {
        timeline(
          {
            action: 'update_audio',
            clipId: result.clipId,
            patch: { durationMs: 8000, loop: true, volume: 0.2, fadeOutMs: 400 },
          },
          'mix-music',
        );
        return;
      }
    }
    if (scenario === 'storyboard' && message.result.success) {
      const result = JSON.parse(message.result.contentItems[0].text).data;
      if (message.id === 'rpc-edit_world_setting') {
        storyboardTool('generate_world_reference', { settingId: result.settingId, kind: 'image' });
        return;
      }
      if (message.id === 'rpc-generate_world_reference') {
        storyboardTool(
          'edit_world_setting',
          { action: 'link', settingId: result.settingId, nodeIds: ['scene_intro'] },
          'link-setting',
        );
        return;
      }
      if (message.id === 'rpc-link-setting') {
        storyboardTool('edit_production_shot', {
          action: 'create',
          nodeId: 'scene_intro',
          label: '开场分镜',
          durationMs: 3000,
          firstFramePrompt: '低机位近景，晨光掠过测试一封信。',
        });
        return;
      }
    }
    if (
      scenario === 'storyboard' &&
      message.id === 'rpc-edit_production_shot' &&
      message.result.success
    ) {
      const { shotId } = JSON.parse(message.result.contentItems[0].text).data;
      storyboardTool('generate_shot_image', { shotId });
      return;
    }
    replies++;
    if (scenario === 'tools-hang') return;
    if (scenario === 'tool-error' && replies === 1) {
      tool(2);
      return;
    }
    if (scenario !== 'parallel' || replies === 2) finish();
  }
});
