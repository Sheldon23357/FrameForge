import { z } from 'zod';

export const creativeGenres = [
  '悬疑',
  '刑侦',
  '犯罪',
  '灵异',
  '恐怖',
  '末世',
  '科幻',
  '奇幻',
  '灾难',
  '冒险',
  '都市',
  '家庭',
  '校园',
  '历史',
  '游戏',
] as const;
export const creativeHooks = [
  '时间循环',
  '规则怪谈',
  '无限流',
  '密室逃生',
  '末日求生',
  '荒野求生',
  '追凶破案',
  '旧案重查',
  '连环案件',
  '身份谜局',
  '失忆',
  '记忆篡改',
  '灵魂互换',
  '平行世界',
  '预知未来',
  'AI觉醒',
  'NPC觉醒',
  '全民游戏',
  '异能觉醒',
  '隐藏身份',
  '错认身份',
  '信息差',
  '反套路',
  '死亡倒计时',
  '封闭空间',
  '全员恶人',
] as const;
export const creativeCharacters = [
  '普通人',
  '学生',
  '职场人',
  '医生',
  '警察',
  '侦探',
  '记者',
  '律师',
  '教师',
  '科学家',
  '创业者',
  '明星',
  '司机',
  '幸存者',
  '腹黑',
  '癫狂',
  '清冷疏离',
  '毒舌',
  '忠犬',
  '白切黑',
  '嘴硬心软',
  '外冷内热',
  '亦正亦邪',
  '反差萌',
  '社恐',
  '社牛',
  '天然呆',
  '天才',
  '怪咖',
  '自信果断',
  '温柔',
  '护短',
] as const;
export const creativeRelationships = [
  '家人',
  '夫妻',
  '情侣',
  '朋友',
  '搭档',
  '师徒',
  '同事',
  '上下级',
  '宿敌',
  '竞争对手',
  '队友',
  '陌生人',
  '邻居',
] as const;
export const creativeTones = [
  '烧脑',
  '反转',
  '悬疑',
  '紧张',
  '刺激',
  '惊悚',
  '恐怖',
  '诡异',
  '猎奇',
  '智斗',
  '生存',
  '揭秘',
  '压迫感',
  '治愈',
  '温情',
  '催泪',
  '搞笑',
] as const;
export const creativeAudiences = ['男频', '女频', '泛人群'] as const;
export const creativeViewpoints = ['主角第一人称', '跟随主角', '多角色视角'] as const;
export const creativeStyleGroups = {
  真人: [
    '古偶柔光滤镜风',
    '韩系高颜值偶像剧风',
    '国产高颜值现偶风',
    '精品古装偶像剧',
    '千禧年代国产剧风',
    '美式复古好莱坞',
    '韩剧都市柔光',
    '国产都市写实',
    '中式志怪电影感',
    '年代乡土生活剧',
    '东方写意武侠江湖电影',
    '复古DV质感风',
    '国产悬疑冷调',
    '90年代写实电影风格',
  ],
  '2D': [
    '国漫二次元常用风格',
    '日本昭和动漫风',
    '黑白水墨国画风格',
    '中国神话描金风',
    '美式黑暗插画风格',
    '黑白漫画书风格',
    '暗黑奇幻原画概念美术',
    '简洁插画风格',
    '日系平涂插画风格',
  ],
  '3D': [
    '半写实精致 CG 渲染',
    '国漫3D高清渲染风',
    '欧美超现实游戏CG渲染风',
    '3D美式卡通游戏美术',
    '高清3D真实渲染风格',
    '高品质动画渲染风格',
    '粘土动画风格',
    '3D卡通微缩景观',
    '动漫三渲二风格',
  ],
} as const;

const supportedHooks = [
  ...creativeHooks,
  '追查旧案',
  '资源取舍',
  '对手联手',
  '信任背叛',
  '记忆缺失',
] as const;
const supportedTones = [
  ...creativeTones,
  '紧张压迫',
  '克制冷峻',
  '轻松明快',
  '温暖治愈',
  '黑色幽默',
] as const;
const supportedStyles = [
  ...creativeStyleGroups.真人,
  ...creativeStyleGroups['2D'],
  ...creativeStyleGroups['3D'],
  '电影写实',
  '冷调悬疑',
  '复古纪实',
  '都市柔光',
  '二次元',
  '国风水墨',
] as const;
export const creativeVisualStyleSchema = z.enum(supportedStyles);

export const creativeDefaultsSchema = z.strictObject({
  genre: z.string().trim().min(1).max(60).optional(),
  hooks: z.array(z.enum(supportedHooks)).max(supportedHooks.length).optional(),
  characterTags: z.array(z.enum(creativeCharacters)).max(creativeCharacters.length).optional(),
  relationships: z
    .array(z.enum(creativeRelationships))
    .max(creativeRelationships.length)
    .optional(),
  tone: z.enum(supportedTones).optional(),
  audience: z.enum(creativeAudiences).optional(),
  viewpoint: z.enum(creativeViewpoints).optional(),
  visualStyle: creativeVisualStyleSchema.optional(),
  chapterCount: z.number().int().min(1).max(10000).optional(),
});
export type CreativeDefaults = z.infer<typeof creativeDefaultsSchema>;
export const creativeOptionsSchema = creativeDefaultsSchema.extend({
  aspectRatio: z.enum(['16:9', '9:16']).optional(),
});
export type CreativeOptions = z.infer<typeof creativeOptionsSchema>;

export const creativeDefaultsPatchSchema = creativeDefaultsSchema.extend({
  genre: creativeDefaultsSchema.shape.genre.nullable(),
  hooks: creativeDefaultsSchema.shape.hooks.nullable(),
  characterTags: creativeDefaultsSchema.shape.characterTags.nullable(),
  relationships: creativeDefaultsSchema.shape.relationships.nullable(),
  tone: creativeDefaultsSchema.shape.tone.nullable(),
  audience: creativeDefaultsSchema.shape.audience.nullable(),
  viewpoint: creativeDefaultsSchema.shape.viewpoint.nullable(),
  visualStyle: creativeDefaultsSchema.shape.visualStyle.nullable(),
  chapterCount: creativeDefaultsSchema.shape.chapterCount.nullable(),
});
type CreativeDefaultsPatch = z.infer<typeof creativeDefaultsPatchSchema>;

export function updateCreativeDefaults(
  settings: { creativeDefaults?: CreativeDefaults },
  patch: CreativeDefaultsPatch | null,
) {
  const overrides = Object.fromEntries(
    Object.entries(patch ?? {}).filter(([, value]) => value !== undefined),
  );
  const next =
    patch === null
      ? {}
      : Object.fromEntries(
          Object.entries({ ...settings.creativeDefaults, ...overrides }).filter(
            ([, value]) => value != null && (!Array.isArray(value) || value.length),
          ),
        );
  if (Object.keys(next).length) settings.creativeDefaults = creativeDefaultsSchema.parse(next);
  else delete settings.creativeDefaults;
}

export function describeCreativeOptions(options: CreativeOptions = {}) {
  return [
    options.genre,
    ...(options.hooks ?? []),
    ...(options.characterTags ?? []),
    ...(options.relationships ?? []),
    options.tone,
    options.audience,
    options.viewpoint,
    options.visualStyle,
    options.aspectRatio,
    options.chapterCount && `${options.chapterCount} 章`,
  ]
    .filter(Boolean)
    .join(' · ');
}
