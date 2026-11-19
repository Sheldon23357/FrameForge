import { z } from 'zod';
import {
  atmosphereToneSchema,
  resolveProjectArtStyle,
  selectableArtStyleSchema,
} from '../../domain/art-style';
import { projectAspect } from '../../domain/project-aspect';
import { creativeDefaultsPatchSchema, updateCreativeDefaults } from '../../domain/creative-options';
import { arrangeBlueprint } from '../../domain/blueprint-layout';
import { assetCategories, filterAssets, removeAsset } from '../../domain/assets';
import { itemSchema, variableSchema } from '../../domain/schema';
import { validateProject } from '../../domain/validation';
import { routeSimulationFields, simulateStoryRoute } from './route-simulation';
import { exploreStoryRoutes } from '../../runtime/routes';
import { runWriteBatch, ToolRegistry } from './registry';
import { numberLiteral, parseNumericLiteral } from './numeric-input';

const gameDataWriteAction = z.enum(['create', 'update', 'upsert']).optional();
const itemQuantity = itemSchema.shape.initial.or(
  z.string().regex(numberLiteral).transform(Number).pipe(itemSchema.shape.initial),
);

function gameDataInitial(kind: unknown, type: unknown, value: unknown) {
  if (kind === 'item' || type === 'number') return parseNumericLiteral(value);
  if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

export function gameDataWriteArguments(args: Record<string, unknown>) {
  if (args.action === 'delete') return args;
  const { action, ...definition } = args;
  if (action === 'create') delete definition.id;
  definition.initial = gameDataInitial(definition.kind, definition.type, definition.initial);
  return definition;
}

export function registerProjectTools(r: ToolRegistry) {
  r.register({
    name: 'delete_asset',
    label: '删除素材',
    group: 'project',
    mode: 'write',
    description:
      '按真实素材 ID 从素材库删除未被节点、时间线或设定引用的素材。先用 read_project 的 assets 操作查找 ID。删除可撤销，保留素材文件。',
    schema: z.strictObject({ assetId: z.string().min(1).max(160) }),
    execute: ({ project }, { assetId }) => {
      const asset = removeAsset(project, assetId);
      return { ok: true, summary: `删除素材「${asset.name}」`, data: { assetId } };
    },
  });
  r.register({
    name: 'arrange_blueprint',
    label: '自动整理蓝图',
    group: 'project',
    mode: 'write',
    description:
      '按剧情连线从左到右整理蓝图坐标。默认整理当前可见范围；scope=all 整理整个工程。只调整节点位置。',
    schema: z.strictObject({ scope: z.enum(['visible', 'all']).default('visible') }),
    execute: ({ project, activeChapterId }, { scope }) => {
      const positions = arrangeBlueprint(project, scope === 'all' ? null : activeChapterId);
      Object.assign(project.layout, positions);
      const count = Object.keys(positions).length;
      return { ok: true, summary: `已整理 ${count} 个节点的位置`, data: { count } };
    },
  });
  r.register({
    name: 'read_project',
    label: '查询工程与素材',
    group: 'project',
    mode: 'read',
    description:
      '默认或 action=overview 读取工程概况；action=assets 按名称、类型或素材库分类分页检索素材。category 可查 music 音乐、voice 语音、sound 音效、reference 设定图；type=audio 查询全部音频。返回真实素材 ID 和续页位置。',
    schema: z.union([
      z.strictObject({ action: z.literal('overview').optional() }),
      z.strictObject({
        action: z.literal('assets'),
        query: z.string().max(200).optional(),
        type: z.enum(['video', 'image', 'audio']).optional(),
        category: z.enum([...assetCategories, 'audio']).optional(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    ]),
    execute: (c, a) => {
      if (a.action === 'assets') {
        const rows = filterAssets(c.project, a);
        return {
          ok: true,
          summary: `找到 ${rows.length} 个素材`,
          data: {
            total: rows.length,
            offset: a.offset,
            nextOffset: a.offset + a.limit < rows.length ? a.offset + a.limit : null,
            truncated: a.offset + a.limit < rows.length,
            assets: rows
              .slice(a.offset, a.offset + a.limit)
              .map(({ id, name, type, width, height, durationMs }) => ({
                id,
                name,
                type,
                width,
                height,
                durationMs,
              })),
          },
        };
      }
      return {
        ok: true,
        summary: '读取工程概况',
        data: {
          id: c.project.id,
          title: c.project.title,
          description: c.project.description.slice(0, 3000),
          settings: c.project.settings,
          startNodeId: c.project.startNodeId,
          selectedIds: c.selectedIds,
          activeChapterId: c.activeChapterId,
          sceneCount: c.project.scenes.length,
          worldSettingCount: c.project.worldSettings?.length ?? 0,
          productionShotCount: c.project.productionShots?.length ?? 0,
          chapters: c.project.chapters.slice(0, 100),
          chapterCount: c.project.chapters.length,
          variables: c.project.variables.slice(0, 100),
          variableCount: c.project.variables.length,
          items: c.project.items.slice(0, 100),
          itemCount: c.project.items.length,
          assetCount: c.project.assets.length,
        },
      };
    },
  });
  r.register({
    name: 'list_game_data',
    label: '检索属性和道具',
    group: 'rules',
    mode: 'read',
    description: '分页读取属性和道具的真实 ID、初始值，以及属性的 hidden 可见性。',
    schema: z.object({
      kind: z.enum(['variable', 'item']),
      query: z.string().max(200).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    execute: (c, a) => {
      const rows = (a.kind === 'variable' ? c.project.variables : c.project.items).filter(
        (v) => !a.query || v.name.includes(a.query),
      );
      return {
        ok: true,
        summary: `找到 ${rows.length} 条定义`,
        data: { total: rows.length, rows: rows.slice(a.offset, a.offset + a.limit) },
      };
    },
  });
  r.register({
    name: 'update_project',
    label: '修改工程信息',
    group: 'project',
    mode: 'write',
    description:
      '维护作品名称、简介、作者及项目创作参数。故事背景、观感偏好、受众偏好分别通过 creativeDefaults.genre、tone、audience 保存。改画幅同时传 width、height，横屏 1920×1080，竖屏 1080×1920。选择具名画风用 creativeDefaults.visualStyle，选择基础画风用 artStyle.preset（realistic 或 anime）并传 creativeDefaults.visualStyle=null。atmosphereTone 对应风格补充描述，可写配色、光线、材质和线条。旧工程兼容 artStyle.description 和 creativeDefaults 下的 hooks、characterTags、relationships、viewpoint、chapterCount。补齐项目参数时只传要变更的字段。字段传 null 清除该项，creativeDefaults=null 清除全部默认值。',
    schema: z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(20000).optional(),
      author: z.string().max(300).optional(),
      width: z.number().int().min(128).max(16384).optional(),
      height: z.number().int().min(128).max(16384).optional(),
      artStyle: selectableArtStyleSchema.nullable().optional(),
      atmosphereTone: atmosphereToneSchema.nullable().optional(),
      creativeDefaults: creativeDefaultsPatchSchema.nullable().optional(),
    }),
    execute: (c, a) => {
      const { title, description, artStyle, atmosphereTone, creativeDefaults, ...settings } = a;
      const currentStyle = resolveProjectArtStyle(c.project.settings);
      if (settings.width !== undefined || settings.height !== undefined) {
        const width = settings.width ?? c.project.settings.width;
        const height = settings.height ?? c.project.settings.height;
        if (
          (width !== c.project.settings.width || height !== c.project.settings.height) &&
          !projectAspect(width, height)
        )
          throw new Error('画幅只支持横屏 16:9 或竖屏 9:16，请同时填写宽度和高度。');
      }
      if (title !== undefined) c.project.title = title;
      if (description !== undefined) c.project.description = description;
      Object.assign(c.project.settings, settings);
      if (creativeDefaults !== undefined)
        updateCreativeDefaults(c.project.settings, creativeDefaults);
      if (
        creativeDefaults?.visualStyle === undefined &&
        (artStyle === null ||
          (artStyle && currentStyle?.reference && artStyle.preset !== currentStyle.preset))
      )
        updateCreativeDefaults(c.project.settings, { visualStyle: null });
      if (atmosphereTone !== undefined) {
        if (atmosphereTone?.trim()) c.project.settings.atmosphereTone = atmosphereTone.trim();
        else delete c.project.settings.atmosphereTone;
      }
      if (artStyle === null) delete c.project.settings.artStyle;
      else if (artStyle) {
        const existing = c.project.settings.artStyle;
        c.project.settings.artStyle = {
          ...artStyle,
          description: artStyle.description ?? existing?.description,
        };
      }
      return { ok: true, summary: '修改工程信息', data: { fields: Object.keys(a) } };
    },
  });
  const gameDataOperation = z.union([
    z.strictObject({
      action: z.literal('delete'),
      kind: z.enum(['variable', 'item']),
      id: z.string().min(1),
    }),
    z
      .discriminatedUnion('kind', [
        variableSchema
          .omit({ id: true })
          .extend({
            kind: z.literal('variable'),
            action: gameDataWriteAction,
            id: z.string().optional(),
            initial: variableSchema.shape.initial.describe('初始值的类型须与 type 一致。'),
            hidden: z
              .boolean()
              .optional()
              .describe(
                'true 时隐藏玩家属性面板中的该属性及其变化提示，仍参与剧情与存读档。省略时更新保留原值，新建默认 false。',
              ),
          })
          .strict(),
        itemSchema
          .omit({ id: true })
          .extend({
            kind: z.literal('item'),
            action: gameDataWriteAction,
            id: z.string().optional(),
            initial: itemQuantity,
          })
          .strict(),
      ])
      .refine((args) => args.action !== 'update' || !!args.id?.trim(), {
        path: ['id'],
        message: '更新时请先用 list_game_data 查询并填写真实 ID。',
      }),
  ]);
  const gameDataBatch = z.strictObject({
    action: z.literal('batch'),
    operations: z.array(z.unknown()).min(2).max(8),
  });
  r.register({
    name: 'edit_game_data',
    label: '编辑属性或道具',
    group: 'rules',
    mode: 'write',
    description:
      '创建、更新或删除属性（variable）或道具（item）。多个定义用 action=batch，operations 放 2–8 项单项操作，可混合属性和道具，按顺序返回每项结果及真实 ID。新建道具示例 {"action":"create","kind":"item","name":"钥匙","description":"房门钥匙","initial":0}。道具的 initial 是数字，数值属性的 initial 也用数字。更新需真实 id 和完整定义；删除需 kind 和真实 id。支持省略 action，按是否有 id 判断创建或更新。',
    schema: z.union([gameDataOperation, gameDataBatch]),
    modelSchema: z.union([
      gameDataOperation,
      gameDataBatch.extend({ operations: z.array(gameDataOperation).min(2).max(8) }),
    ]),
    execute: (c, a) => {
      if (a.action === 'batch') {
        return runWriteBatch(a.operations, '属性或道具编辑', (operation) => {
          if (
            operation &&
            typeof operation === 'object' &&
            'action' in operation &&
            operation.action === 'batch'
          )
            return { ok: false, summary: '请使用单项编辑 action。' };
          return r.execute('edit_game_data', JSON.stringify(operation), c);
        });
      }
      if (a.action === 'delete') {
        const key = a.kind === 'variable' ? 'variableId' : 'itemId';
        const used = (v: unknown): boolean =>
          !!v &&
          typeof v === 'object' &&
          (Object.entries(v).some(([k, value]) => k === key && value === a.id) ||
            Object.values(v).some(used));
        if (used(c.project.scenes)) throw new Error('该定义仍被剧情引用，请先修改条件或效果。');
        const rows = a.kind === 'variable' ? c.project.variables : c.project.items;
        if (!rows.some((v) => v.id === a.id)) throw new Error('定义不存在。');
        if (a.kind === 'variable')
          c.project.variables = c.project.variables.filter((v) => v.id !== a.id);
        else c.project.items = c.project.items.filter((v) => v.id !== a.id);
        return { ok: true, summary: '删除游戏数据定义', data: { kind: a.kind, id: a.id } };
      }
      const targetId = a.action === 'create' ? undefined : a.id;
      if (a.kind === 'item') {
        const existing = targetId ? c.project.items.find((v) => v.id === targetId) : undefined;
        if (targetId && !existing) throw new Error('道具 ID 不存在。');
        if (c.project.items.some((v) => v.name === a.name && v.id !== targetId))
          throw new Error('已存在同名道具，请读取后按 ID 更新。');
        const id = existing?.id ?? `item_${crypto.randomUUID().slice(0, 12)}`;
        const value = itemSchema.parse({ ...a, id });
        if (existing) Object.assign(existing, value);
        else c.project.items.push(value);
        return { ok: true, summary: `${existing ? '修改' : '创建'}道具「${a.name}」`, data: value };
      }
      const initial = gameDataInitial(a.kind, a.type, a.initial);
      if (typeof initial !== a.type) throw new Error(`initial 必须与属性 type=${a.type} 一致。`);
      if (a.min !== undefined && a.max !== undefined && a.min > a.max)
        throw new Error('最小值大于最大值。');
      const existing = targetId ? c.project.variables.find((v) => v.id === targetId) : undefined;
      if (targetId && !existing)
        throw new Error('属性 ID 不存在。新建请省略 id，更新请先查询真实 ID。');
      if (c.project.variables.some((v) => v.name === a.name && v.id !== targetId))
        throw new Error('已存在同名属性，请读取后按 ID 更新。');
      const id = existing?.id ?? `variable_${crypto.randomUUID().slice(0, 12)}`;
      const value = variableSchema.parse({
        ...a,
        initial,
        id,
        hidden: a.hidden ?? existing?.hidden ?? false,
      });
      if (existing) Object.assign(existing, value);
      else c.project.variables.push(value);
      return { ok: true, summary: `${existing ? '修改' : '创建'}属性「${a.name}」`, data: value };
    },
  });
  r.register({
    name: 'arrange_nodes',
    label: '整理蓝图布局',
    group: 'project',
    mode: 'write',
    description: '按章节将节点排列为网格。只改画布布局，不修改剧情连线。',
    schema: z.object({
      chapterId: z.string().optional(),
      columns: z.number().int().min(1).max(12).default(4),
    }),
    execute: (c, a) => {
      const groups = c.project.chapters.filter((v) => !a.chapterId || v.id === a.chapterId);
      if (!groups.length) throw new Error('章节不存在。');
      let top = 100;
      const ids: string[] = [];
      for (const group of groups) {
        const rows = c.project.scenes.filter((s) => s.chapterId === group.id);
        rows.forEach((s, i) => {
          c.project.layout[s.id] = {
            x: 100 + (i % a.columns) * 320,
            y: top + Math.floor(i / a.columns) * 230,
          };
          ids.push(s.id);
        });
        top += Math.max(1, Math.ceil(rows.length / a.columns)) * 230 + 100;
      }
      return { ok: true, summary: `整理 ${ids.length} 个节点布局`, nodeIds: ids };
    },
  });
  r.register({
    name: 'validate_project',
    label: '检查工程',
    group: 'analysis',
    mode: 'read',
    description:
      '在交付前检查工程结构、引用和分支规则。需要验证某条具体路线时用 check_story 的 simulate 操作。',
    schema: z.object({ offset: z.number().int().nonnegative().default(0) }),
    execute: (c, a) => {
      const rows = validateProject(c.project);
      return {
        ok: true,
        summary: `${rows.filter((v) => v.severity === 'error').length} 个错误，${rows.filter((v) => v.severity === 'warning').length} 条提醒`,
        data: { total: rows.length, issues: rows.slice(a.offset, a.offset + 50) },
      };
    },
  });
  r.register({
    name: 'explore_routes',
    label: '验收可点击分支',
    group: 'analysis',
    mode: 'read',
    description:
      '按真实播放器规则探索可点击选项。默认从全作起点；可传真实 nodeId 从指定章节入口独立试玩。返回可达结局、分支是否跳向不同剧情、路线和阻塞原因。结果支持分页。',
    schema: z.object({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(10).default(5),
      nodeId: z.string().min(1).optional(),
    }),
    execute: ({ project }, { offset, limit, nodeId }) => {
      const { routes, failures, ...summary } = exploreStoryRoutes(project, nodeId);
      const findings = [
        ...failures.map((message) => ({ kind: 'failure', message })),
        ...routes.map((route) => ({ kind: 'ending', ...route })),
      ];
      return {
        ok: true,
        summary: `可达结局 ${summary.endings} 个，阻塞 ${failures.length} 项${summary.distinctChoices ? '，可点击选项通向不同剧情' : '，未发现通向不同剧情的可点击选项'}${summary.truncated ? '，探索达到上限' : ''}`,
        data: {
          ...summary,
          explorationTruncated: summary.truncated,
          failureCount: failures.length,
          total: findings.length,
          offset,
          nextOffset: offset + limit < findings.length ? offset + limit : null,
          truncated: summary.truncated || offset + limit < findings.length,
          findings: findings.slice(offset, offset + limit),
        },
      };
    },
  });
  r.register({
    name: 'simulate_route',
    label: '验证剧情路线',
    group: 'analysis',
    mode: 'read',
    description:
      '按 nodeId 和玩家 choiceIds 模拟路线；也可用 steps 输入 choose/choiceId 或 wait/durationMs 验证选择期间继续播放触发的节点事件。initialVariables、initialInventory 可覆盖模拟初值。detail=summary 查落点，detail=trace 查分步状态。detail=pacing 播到下一选择或终点，返回本路线净播放时长、选择次数、当前页涉及章节的小计及逐节点播放、镜头计划和文字状态。按 offset、limit 分页。净时长只计实际经过的演出，不含选择停留及转场。',
    schema: z.object(routeSimulationFields),
    execute: ({ project }, input) => ({
      ok: true,
      summary: '完成路线模拟',
      data: simulateStoryRoute(project, input),
    }),
  });
  r.register({
    name: 'focus_scene',
    label: '定位节点',
    group: 'view',
    category: 'analysis',
    mode: 'view',
    description: '本轮成功后在蓝图选中并定位节点。',
    schema: z.object({ nodeId: z.string() }),
    execute: (c, a) => {
      if (!c.project.scenes.some((s) => s.id === a.nodeId)) throw new Error('节点不存在。');
      c.intents.push({ kind: 'focus', nodeId: a.nodeId });
      return { ok: true, summary: '准备定位节点', nodeIds: [a.nodeId] };
    },
  });
  r.register({
    name: 'preview_story',
    label: '启动试玩',
    group: 'view',
    category: 'analysis',
    mode: 'view',
    description: '本轮成功后从指定节点或第一章起点启动试玩。',
    schema: z.object({ nodeId: z.string().optional() }),
    execute: (c, a) => {
      const id = a.nodeId ?? c.project.startNodeId;
      if (!c.project.scenes.some((s) => s.id === id)) throw new Error('试玩起点不存在。');
      c.intents.push({ kind: 'preview', nodeId: id });
      return { ok: true, summary: '准备启动试玩', nodeIds: [id] };
    },
  });
}
