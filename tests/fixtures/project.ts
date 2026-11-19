import { makeChoice, sceneSchema, type Project } from '../../packages/domain/schema';
const choice = (id: string, label: string, targetId: string) => ({
  ...makeChoice(label),
  id,
  targetId,
});
export function testProject(): Project {
  const intro = sceneSchema.parse({
    id: 'scene_intro',
    kind: 'video',
    title: '测试开场',
    chapterId: 'chapter_fixture',

    assetId: 'asset_primary',
    durationMs: 9000,
    choicesAtMs: 6000,
    choices: [
      choice('choice_explore', '进入路线 A', 'scene_reward'),
      choice('choice_leave', '进入路线 B', 'scene_alternate'),
    ],
    events: [],
  });
  const encounter = sceneSchema.parse({
    id: 'scene_reward',
    kind: 'video',
    title: '奖励节点',
    chapterId: intro.chapterId,

    assetId: 'asset_secondary',
    durationMs: 9000,
    nextId: 'scene_branch',
    choices: [],
    events: [
      {
        id: 'event_leaf',
        name: '发放道具',
        trigger: 'enter',
        atMs: 0,
        once: true,
        effects: [
          { kind: 'addItem', itemId: 'leaf', count: 1 },
          { kind: 'addVariable', variableId: 'trust', value: 15 },
        ],
      },
    ],
  });
  const clearing = sceneSchema.parse({
    id: 'scene_alternate',
    kind: 'video',
    title: '备选节点',
    chapterId: intro.chapterId,

    assetId: 'asset_tertiary',
    durationMs: 9000,
    choicesAtMs: null,
    choices: [
      choice('choice_return', '返回路线 A', 'scene_reward'),
      choice('choice_continue', '继续向前', 'scene_branch'),
    ],
    events: [
      {
        id: 'event_courage',
        name: '记录路线 B',
        trigger: 'complete',
        atMs: 0,
        once: false,
        effects: [{ kind: 'addVariable', variableId: 'courage', value: 1 }],
      },
    ],
  });
  const gate = sceneSchema.parse({
    id: 'scene_branch',
    kind: 'branch',
    title: '条件节点',
    chapterId: intro.chapterId,

    choices: [
      {
        ...choice('choice_secret', '持有测试道具', 'scene_consume'),
        condition: { kind: 'item', itemId: 'leaf', op: 'gte', count: 1 },
      },
      choice('choice_normal', '其他情况', 'scene_neutral'),
    ],
    events: [],
  });
  const token = sceneSchema.parse({
    id: 'scene_consume',
    kind: 'video',
    title: '消耗节点',
    chapterId: intro.chapterId,
    storyboardPages: [{ text: '测试故事板文字。', durationMs: 2000 }],
    nextId: 'scene_success',
    choices: [],
    events: [
      {
        id: 'event_spend_leaf',
        name: '消耗道具',
        trigger: 'complete',
        atMs: 0,
        once: false,
        effects: [{ kind: 'removeItem', itemId: 'leaf', count: 1 }],
      },
    ],
  });
  const secret = sceneSchema.parse({
    id: 'scene_success',
    kind: 'ending',
    title: '结局 A',
    chapterId: intro.chapterId,
    endingText: '测试结局正文。',
    assetId: 'asset_primary',
    endingLabel: '结局 01 · 结局 A',
    choices: [],
    events: [],
  });
  const home = sceneSchema.parse({
    id: 'scene_neutral',
    kind: 'ending',
    title: '结局 B',
    chapterId: intro.chapterId,
    endingText: '测试结局正文。',
    assetId: 'asset_tertiary',
    endingLabel: '结局 02 · 结局 B',
    choices: [],
    events: [],
  });
  return {
    formatVersion: 4,
    id: 'project_test_fixture',
    title: '测试工程',
    description: '用于自动化测试。',
    revision: 0,
    updatedAt: new Date().toISOString(),
    startNodeId: intro.id,
    settings: { width: 1920, height: 1080, author: '' },
    scenes: [intro, encounter, clearing, gate, secret, home, token],
    chapters: [{ id: intro.chapterId, title: '第一章 · 测试章节', startNodeId: intro.id }],
    variables: [
      { id: 'trust', name: '信任', type: 'number', initial: 30, min: 0, max: 100 },
      { id: 'courage', name: '勇气', type: 'number', initial: 5, min: 0, max: 10 },
    ],
    items: [
      {
        id: 'leaf',
        name: '测试道具',
        description: '',
        initial: 0,
      },
    ],
    assets: ['primary', 'secondary', 'tertiary'].map((name, i) => ({
      id: `asset_${name}`,
      name: ['01_测试画面.mp4', '02_测试画面.mp4', '03_测试画面.mp4'][i],
      path: `test-media/${name}.mp4`,
      type: 'video' as const,
      size: 0,
      durationMs: 9000,
      width: 960,
      height: 540,
      thumbnail: `test-media/${name}.jpg`,
      builtin: true,
    })),
    layout: {
      scene_intro: { x: 50, y: 240 },
      scene_reward: { x: 420, y: 70 },
      scene_alternate: { x: 420, y: 430 },
      scene_branch: { x: 790, y: 260 },
      scene_success: { x: 1530, y: 90 },
      scene_consume: { x: 1160, y: 90 },
      scene_neutral: { x: 1160, y: 450 },
    },
  };
}
