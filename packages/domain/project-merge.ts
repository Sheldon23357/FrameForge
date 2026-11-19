import { parseProject, type Project } from './schema';
import { validateProject } from './validation';

type RecordValue = Record<string, unknown>;
type Entity = RecordValue & { id: string };
type MergeResult = { project: Project } | { error: string };

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const field = (value: RecordValue, key: string) =>
  Object.hasOwn(value, key) ? value[key] : undefined;

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, i) => equal(item, right[i]));
  return (
    isRecord(left) &&
    isRecord(right) &&
    Object.keys(left).every((key) => equal(left[key], field(right, key))) &&
    Object.keys(right).every((key) => Object.hasOwn(left, key) || right[key] === undefined)
  );
}

function isEntityList(items: unknown[]): items is Entity[] {
  return (
    items.every((item): item is Entity => isRecord(item) && typeof item.id === 'string') &&
    new Set(items.map((item) => item.id)).size === items.length
  );
}

// Keep the chosen order and place additions from the other list beside their next shared item.
function insertAdditions(order: string[], other: string[]) {
  const present = new Set(order);
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const id of other) {
    if (!present.has(id)) pending.push(id);
    else if (pending.length) {
      before.set(id, pending);
      pending = [];
    }
  }
  return [...order.flatMap((id) => [...(before.get(id) ?? []), id]), ...pending];
}

export function mergeProjectEdits(base: Project, current: Project, draft: Project): MergeResult {
  return mergeProject(base, current, draft, false);
}

/** A canvas preview may contain unfinished routes. It is never a commit candidate. */
export function previewProjectEdits(base: Project, current: Project, draft: Project) {
  const result = mergeProject(base, current, draft, true);
  return 'project' in result ? result.project : undefined;
}

function mergeProject(
  base: Project,
  current: Project,
  draft: Project,
  preview: boolean,
): MergeResult {
  if (base.id !== current.id || base.id !== draft.id) return { error: '草稿所属工程已切换。' };
  const conflicts: string[] = [];
  const conflict = (path: string) => {
    if (conflicts.length < 6) conflicts.push(path);
  };

  function merge(before: unknown, user: unknown, agent: unknown, path: string): unknown {
    if (equal(before, agent) || equal(user, agent)) return user;
    if (equal(before, user)) return agent;

    if (
      (before === undefined || isRecord(before)) &&
      isRecord(user) &&
      isRecord(agent) &&
      ['kind', 'type'].every((key) => {
        const tag = before && field(before, key);
        return (
          equal(field(user, key), field(agent, key)) &&
          (tag === undefined || equal(tag, field(user, key)))
        );
      })
    ) {
      const original = before ?? {};
      const keys = new Set([...Object.keys(user), ...Object.keys(agent)]);
      const entries = [...keys].map((key) => [
        key,
        merge(
          field(original, key),
          field(user, key),
          field(agent, key),
          path ? path + '.' + key : key,
        ),
      ]);
      return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
    }

    const original = before === undefined ? [] : before;
    if (
      Array.isArray(original) &&
      isEntityList(original) &&
      Array.isArray(user) &&
      isEntityList(user) &&
      Array.isArray(agent) &&
      isEntityList(agent)
    ) {
      const byId = (items: Entity[]) => new Map(items.map((item) => [item.id, item]));
      const old = byId(original);
      const local = byId(user);
      const incoming = byId(agent);
      const values = new Map<string, unknown>();
      for (const id of new Set([...local.keys(), ...incoming.keys()])) {
        const previous = old.get(id);
        const latest = local.get(id);
        const proposed = incoming.get(id);
        const itemPath = `${path}[${id}]`;
        if (!previous && latest && proposed && !equal(latest, proposed)) {
          conflict(itemPath);
          continue;
        }
        const value = merge(previous, latest, proposed, itemPath);
        if (value !== undefined) values.set(id, value);
      }
      const common = original.map(({ id }) => id).filter((id) => local.has(id) && incoming.has(id));
      const commonIds = new Set(common);
      const userOrder = [...local.keys()].filter((id) => commonIds.has(id));
      const agentOrder = [...incoming.keys()].filter((id) => commonIds.has(id));
      const userReordered = !equal(common, userOrder);
      const agentReordered = !equal(common, agentOrder);
      if (userReordered && agentReordered && !equal(userOrder, agentOrder))
        conflict(`${path}（顺序）`);
      const kept = (items: Map<string, Entity>) => [...items.keys()].filter((id) => values.has(id));
      const order =
        agentReordered && !userReordered
          ? insertAdditions(kept(incoming), kept(local))
          : insertAdditions(kept(local), kept(incoming));
      return order.map((id) => values.get(id));
    }

    conflict(path);
    return user;
  }

  const content = ({
    revision: _revision,
    updatedAt: _time,
    startNodeId: _start,
    layout: _layout,
    ...p
  }: Project) => p;
  const merged = merge(content(base), content(current), content(draft), '') as Omit<
    Project,
    'revision' | 'updatedAt' | 'startNodeId' | 'layout'
  >;
  if (conflicts.length)
    return { error: '当前工程与草稿存在冲突，请检查 ' + conflicts.join('、') + '。' };

  const layout = { ...draft.layout };
  for (const id of new Set([...Object.keys(base.layout), ...Object.keys(current.layout)])) {
    if (equal(field(base.layout, id), field(current.layout, id))) continue;
    if (Object.hasOwn(current.layout, id)) layout[id] = current.layout[id];
    else delete layout[id];
  }
  // A layout-only change must never bring back a position for a removed scene.
  const sceneIds = new Set(merged.scenes.map(({ id }) => id));
  for (const id of Object.keys(layout)) if (!sceneIds.has(id)) delete layout[id];

  try {
    const { revision, updatedAt, startNodeId } = current;
    const project = parseProject({ ...merged, revision, updatedAt, startNodeId, layout });
    if (preview) return { project };
    const key = (issue: ReturnType<typeof validateProject>[number]) =>
      JSON.stringify([issue.nodeId, issue.message]);
    const baseline = new Set(
      validateProject(current)
        .filter((i) => i.severity === 'error')
        .map(key),
    );
    const errors = validateProject(project)
      .filter((issue) => issue.severity === 'error' && !baseline.has(key(issue)))
      .slice(0, 5);
    if (errors.length)
      return { error: '合并后工程校验失败。' + errors.map((issue) => issue.message).join('；') };
    return { project };
  } catch (error) {
    return { error: '合并后工程数据无效。' + (error instanceof Error ? error.message : '') };
  }
}
