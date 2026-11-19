import { parseProject, uid, type Project } from './schema';
import { z } from 'zod';

type Path = (string | number)[];
const pathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
export const projectChangesSchema = z.array(
  z.discriminatedUnion('kind', [
    z.object({ path: pathSchema, kind: z.literal('set'), value: z.unknown() }),
    z.object({ path: pathSchema, kind: z.literal('remove') }),
    z.object({
      path: pathSchema,
      kind: z.literal('splice'),
      index: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
      items: z.array(z.unknown()),
    }),
  ]),
);
type Change = z.infer<typeof projectChangesSchema>[number];

export interface VersionInfo {
  id: string;
  at: string;
  title: string;
  details: string[];
}
export interface ProjectVersion extends VersionInfo {
  reverse: Change[];
}

const limit = 60;
const sizeLimit = 1_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const reserved = (key: string | number) =>
  ['__proto__', 'constructor', 'prototype'].includes(String(key));

function differences(previous: unknown, current: unknown, path: Path, result: Change[]) {
  if (Object.is(previous, current)) return;
  if (Array.isArray(previous) && Array.isArray(current)) {
    if (previous.length === current.length) {
      previous.forEach((item, index) =>
        differences(item, current[index], [...path, index], result),
      );
    } else {
      const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const common = Math.min(previous.length, current.length);
      let prefix = 0;
      let suffix = 0;
      while (prefix < common && equal(previous[prefix], current[prefix])) prefix++;
      while (
        suffix + prefix < common &&
        equal(previous[previous.length - 1 - suffix], current[current.length - 1 - suffix])
      )
        suffix++;
      result.push({
        path,
        kind: 'splice',
        index: prefix,
        count: current.length - prefix - suffix,
        items: previous.slice(prefix, previous.length - suffix),
      });
    }
  } else if (isRecord(previous) && isRecord(current)) {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)]))
      differences(previous[key], current[key], [...path, key], result);
  } else {
    result.push(
      previous === undefined ? { path, kind: 'remove' } : { path, kind: 'set', value: previous },
    );
  }
}

function apply(project: Project, entries: readonly ProjectVersion[]) {
  const copy = structuredClone(project);
  const at = (path: Path) =>
    path.reduce<unknown>((value, key) => {
      if (
        reserved(key) ||
        value === null ||
        typeof value !== 'object' ||
        !Object.hasOwn(value, key)
      )
        throw new Error('版本记录无法应用到当前工程。');
      return Reflect.get(value, key);
    }, copy);
  for (const entry of entries) {
    for (const change of entry.reverse) {
      if (change.kind === 'splice') {
        const array = at(change.path);
        if (
          !Array.isArray(array) ||
          !Number.isInteger(change.index) ||
          change.index < 0 ||
          !Number.isInteger(change.count) ||
          change.count < 0 ||
          change.index + change.count > array.length ||
          !Array.isArray(change.items)
        )
          throw new Error('版本中的列表修改无效。');
        array.splice(change.index, change.count, ...structuredClone(change.items));
      } else {
        const key = change.path.at(-1);
        const target = at(change.path.slice(0, -1));
        if (key === undefined || reserved(key) || target === null || typeof target !== 'object')
          throw new Error('版本中的字段修改无效。');
        if (change.kind === 'set') Reflect.set(target, key, structuredClone(change.value));
        else if (change.kind === 'remove') Reflect.deleteProperty(target, key);
        else throw new Error('版本记录包含未知操作。');
      }
    }
  }
  return copy;
}

export function projectChanges(base: Project, candidate: Project) {
  const changes: Change[] = [];
  differences(
    base,
    { ...candidate, revision: base.revision, updatedAt: base.updatedAt },
    [],
    changes,
  );
  return changes;
}

export function applyProjectChanges(project: Project, changes: Change[]) {
  return parseProject(
    apply(project, [{ id: '', at: '', title: '', details: [], reverse: changes }]),
  );
}

function summarize(before: Project, after: Project, changes: Change[]) {
  const details: string[] = [];
  const names = (values: string[]) =>
    values
      .slice(0, 3)
      .map((name) => '「' + (name.length > 36 ? name.slice(0, 36) + '…' : name) + '」')
      .join('、') + (values.length > 3 ? '等' : '');
  const categories = [
    ['chapters', '章节'],
    ['scenes', '节点'],
    ['variables', '属性'],
    ['items', '道具'],
    ['assets', '素材'],
    ['worldSettings', '设定'],
    ['productionShots', '制作镜头'],
  ] as const;
  for (const [key, label] of categories) {
    if (!changes.some((change) => change.path[0] === key)) continue;
    const previous = new Map((before[key] ?? []).map((item) => [item.id, item]));
    const current = new Map((after[key] ?? []).map((item) => [item.id, item]));
    const name = (item: NonNullable<(typeof after)[typeof key]>[number]) =>
      'title' in item ? item.title : 'name' in item ? item.name : item.label;
    const added = [...current.values()].filter((item) => !previous.has(item.id));
    const removed = [...previous.values()].filter((item) => !current.has(item.id));
    const modified = [...current.values()].filter(
      (item) =>
        previous.has(item.id) && JSON.stringify(previous.get(item.id)) !== JSON.stringify(item),
    );
    if (added.length)
      details.push('新增 ' + added.length + ' 个' + label + ' · ' + names(added.map(name)));
    if (removed.length)
      details.push('删除 ' + removed.length + ' 个' + label + ' · ' + names(removed.map(name)));
    if (modified.length) {
      let action = '修改' + label;
      if (key === 'scenes') {
        const fields = new Set(
          changes.filter((item) => item.path[0] === 'scenes').map((item) => item.path[2]),
        );
        const groups = [
          [fields.has('title'), '名称'],
          [fields.has('notes'), '备注'],
          [fields.has('storyboardPages') || fields.has('storyboardOverlay'), '剧情文字'],
          [fields.has('settingIds'), '设定关联'],
          [
            fields.has('choices') ||
              fields.has('choiceQuestion') ||
              fields.has('nextId') ||
              fields.has('choicesAtMs') ||
              fields.has('choiceMode'),
            '选项和跳转',
          ],
          [fields.has('events'), '事件'],
          [
            fields.has('timeline') ||
              fields.has('assetId') ||
              fields.has('trimStartMs') ||
              fields.has('trimEndMs') ||
              fields.has('durationMs'),
            '时间线',
          ],
          [fields.has('chapterId'), '章节归属'],
        ] as const;
        const fieldsChanged = groups.filter(([changed]) => changed).map(([, label]) => label);
        if (fieldsChanged.length) action = '修改节点' + fieldsChanged.join('、');
      }
      details.push(action + ' · ' + names(modified.map(name)));
    }
    if (!added.length && !removed.length && !modified.length) details.push('调整' + label + '顺序');
  }
  if (changes.some(({ path }) => path[0] === 'title'))
    details.push('修改作品名称 · ' + names([after.title]));
  if (changes.some(({ path }) => path[0] === 'description' || path[0] === 'settings'))
    details.push('修改作品信息或画面设置');
  if (changes.some(({ path }) => path[0] === 'layout')) details.push('调整蓝图布局');
  if (changes.some(({ path }) => path[0] === 'storyDesign')) details.push('修改剧情大纲');
  if (changes.some(({ path }) => path[0] === 'screenplays')) details.push('修改剧本正文');
  return details.length ? details : ['修改工程起点'];
}

export function initialVersion(project: Project): ProjectVersion[] {
  return [
    {
      id: uid('version'),
      at: project.updatedAt,
      title: '开始记录此工程',
      details: [],
      reverse: [],
    },
  ];
}

export function recordVersion(
  versions: readonly ProjectVersion[],
  before: Project,
  after: Project,
  merge = false,
  title?: string,
): ProjectVersion[] | undefined {
  const canMerge = merge && versions.length > 1;
  const base = canMerge ? apply(before, versions.slice(0, 1)) : before;
  const reverse: Change[] = [];
  differences(
    { ...base, revision: 0, updatedAt: '' },
    { ...after, revision: 0, updatedAt: '' },
    [],
    reverse,
  );
  if (!reverse.length) return canMerge ? versions.slice(1) : undefined;
  const details = summarize(base, after, reverse);
  const version: ProjectVersion = {
    id: canMerge ? versions[0].id : uid('version'),
    at: new Date().toISOString(),
    title: title ?? details[0],
    details,
    reverse,
  };
  const retained = [version, ...versions.slice(canMerge ? 1 : 0)].slice(0, limit);
  let size = 0;
  let count = 0;
  for (const entry of retained) {
    size += JSON.stringify(entry).length;
    if (size > sizeLimit && count > 0) break;
    count++;
  }
  const bounded = retained.slice(0, count);
  bounded[count - 1] = { ...bounded[count - 1], reverse: [] };
  return bounded;
}

export function projectAtVersion(
  project: Project,
  versions: readonly ProjectVersion[],
  id: string,
): Project {
  const index = versions.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error('这个版本已不存在。');
  return parseProject(apply(project, versions.slice(0, index)));
}

export function versionInfo({ id, at, title, details }: ProjectVersion): VersionInfo {
  return { id, at, title, details };
}

export function changedAssetIds(before: Project, after: Project) {
  const previous = new Map(before.assets.map((asset) => [asset.id, asset]));
  return after.assets
    .filter((asset) => {
      const old = previous.get(asset.id);
      return (
        !old ||
        old.path !== asset.path ||
        old.thumbnail !== asset.thumbnail ||
        old.builtin !== asset.builtin
      );
    })
    .map((asset) => asset.id);
}
