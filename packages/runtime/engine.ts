import { Choice, Condition, Effect, Project, Scene, Value } from '../domain/schema';
import { chapterTitle, storyStartId } from '../domain/schema';
import { isRuntimeNotice, type RuntimeNotice } from './notifications';
import { activeStoryboard, nodeDuration } from '../domain/timeline';
import { automaticBranchLimit } from '../domain/story-graph';
export interface RuntimeState {
  nodeId: string;
  phase: 'playing' | 'choosing' | 'ended';
  positionMs: number;
  variables: Record<string, Value>;
  inventory: Record<string, number>;
  visited: string[];
  takenChoices: string[];
  fired: string[];
  visitSerial: number;
  logSequence?: number;
  log: {
    message: string;
    nodeId: string;
    sequence?: number;
    notice?: RuntimeNotice;
    entered?: true;
  }[];
}
export class RuntimeError extends Error {}
const copy = <T>(v: T): T => structuredClone(v);
const compare = (a: Value, op: string, b: Value) => {
  if (typeof a !== typeof b) return false;
  if (op === 'eq') return a === b;
  if (op === 'ne') return a !== b;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
};
export function evaluate(c: Condition, s: RuntimeState): boolean {
  if (c.kind === 'all') return c.children.every((x) => evaluate(x, s));
  if (c.kind === 'any') return c.children.some((x) => evaluate(x, s));
  if (c.kind === 'not') return !evaluate(c.child, s);
  if (c.kind === 'visited') return s.visited.includes(c.nodeId);
  if (c.kind === 'variable') return compare(s.variables[c.variableId], c.op, c.value);
  if (c.kind === 'item') return compare(s.inventory[c.itemId] ?? 0, c.op, c.count);
  return false;
}
function log(s: RuntimeState, message: string, notice?: RuntimeNotice, entered?: true) {
  s.logSequence = (s.logSequence ?? 0) + 1;
  s.log.push({
    message,
    nodeId: s.nodeId,
    sequence: s.logSequence,
    ...(notice ? { notice } : {}),
    ...(entered ? { entered } : {}),
  });
  if (s.log.length > 150) s.log.shift();
}
/** Transactional: a failed effect never mutates the caller's state. */
export function applyEffects(p: Project, input: RuntimeState, effects: Effect[]): RuntimeState {
  const s = copy(input);
  for (const e of effects) {
    if (e.kind === 'showMessage') {
      if (!e.text.trim() || e.text.length > 2000 || e.title.length > 100)
        throw new RuntimeError('剧情提示内容无效。');
      log(s, e.text, { kind: 'message', name: e.title || '剧情提示', text: e.text });
      continue;
    }
    if (e.kind === 'addItem' || e.kind === 'removeItem') {
      const item = p.items.find((i) => i.id === e.itemId);
      if (!item) throw new RuntimeError('效果引用了不存在的道具。');
      if (!Number.isInteger(e.count) || e.count <= 0)
        throw new RuntimeError('道具数量必须为正整数。');
      const amount = (s.inventory[e.itemId] ?? 0) + (e.kind === 'addItem' ? e.count : -e.count);
      if (amount < 0) throw new RuntimeError(`道具「${item.name}」数量不足。`);
      s.inventory[e.itemId] = amount;
      log(s, `${e.kind === 'addItem' ? '获得' : '消耗'} ${item.name} × ${e.count}`, {
        kind: 'item',
        name: item.name,
        delta: e.kind === 'addItem' ? e.count : -e.count,
        total: amount,
      });
    } else {
      const def = p.variables.find((v) => v.id === e.variableId);
      if (!def) throw new RuntimeError('效果引用了不存在的属性。');
      const current = s.variables[e.variableId];
      let value: Value = e.value;
      if (e.kind === 'addVariable') {
        if (typeof current !== 'number' || def.type !== 'number')
          throw new RuntimeError(`「${def.name}」不是数值属性。`);
        value = current + e.value;
      }
      if (typeof value !== def.type) throw new RuntimeError(`「${def.name}」的值类型不正确。`);
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new RuntimeError('属性数值无效。');
        value = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value));
      }
      s.variables[e.variableId] = value;
      log(
        s,
        `${def.name} → ${String(value)}`,
        current === value || def.hidden
          ? undefined
          : {
              kind: 'variable',
              name: def.name,
              before: current,
              after: value,
            },
      );
    }
  }
  return s;
}
export function getScene(p: Project, s: RuntimeState): Scene {
  const scene = p.scenes.find((n) => n.id === s.nodeId);
  if (!scene) throw new RuntimeError('当前剧情节点不存在。');
  return scene;
}
export function sceneDuration(p: Project, n: Scene): number {
  return nodeDuration(p, n);
}
function events(
  p: Project,
  input: RuntimeState,
  trigger: Scene['events'][number]['trigger'],
): RuntimeState {
  let s = input;
  for (const e of getScene(p, s).events) {
    const key = e.once ? e.id : `${s.visitSerial}:${e.id}`;
    if (
      e.trigger !== trigger ||
      s.fired.includes(key) ||
      (trigger === 'time' && e.atMs > s.positionMs)
    )
      continue;
    const eventState = copy(s);
    log(eventState, `事件：${e.name}`, { kind: 'event', name: e.name });
    s = applyEffects(p, eventState, e.effects);
    s.fired.push(key);
  }
  return s;
}
function enter(p: Project, input: RuntimeState, id: string, depth = 0): RuntimeState {
  if (depth > automaticBranchLimit)
    throw new RuntimeError(`连续自动跳转超过 ${automaticBranchLimit} 次，可能存在循环。`);
  let s = {
    ...input,
    nodeId: id,
    positionMs: 0,
    phase: 'playing' as RuntimeState['phase'],
    visitSerial: input.visitSerial + 1,
  };
  const n = getScene(p, s);
  if (!s.visited.includes(id)) s.visited.push(id);
  log(s, `进入：${n.title}`, undefined, true);
  s = events(p, s, 'enter');
  s = events(p, s, 'time');
  if (n.kind === 'ending') {
    s.phase = 'ended';
    return s;
  }
  if (n.kind === 'branch') {
    const c = n.choices.find((c) => evaluate(c.condition, s));
    if (!c) throw new RuntimeError(`「${n.title}」没有满足条件的出口。`);
    s = events(p, s, 'exit');
    log(s, `自动分支：${c.label}`);
    if (!s.takenChoices.includes(c.id)) s.takenChoices.push(c.id);
    return enter(p, s, c.targetId, depth + 1);
  }
  if (n.choices.length && n.choicesAtMs === 0) s.phase = 'choosing';
  return s;
}
export function start(
  p: Project,
  nodeId = storyStartId(p),
  overrides?: { variables?: Record<string, Value>; inventory?: Record<string, number> },
): RuntimeState {
  const s: RuntimeState = {
    nodeId,
    phase: 'playing',
    positionMs: 0,
    variables: Object.fromEntries(p.variables.map((v) => [v.id, v.initial])),
    inventory: Object.fromEntries(p.items.map((i) => [i.id, i.initial])),
    visited: [],
    takenChoices: [],
    fired: [],
    visitSerial: 0,
    log: [],
    logSequence: 0,
  };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides.variables ?? {})) {
      const def = p.variables.find((v) => v.id === key);
      if (
        !def ||
        typeof value !== def.type ||
        (typeof value === 'number' &&
          (!Number.isFinite(value) ||
            (def.min !== undefined && value < def.min) ||
            (def.max !== undefined && value > def.max)))
      )
        throw new RuntimeError('测试属性的类型或范围无效。');
      s.variables[key] = value;
    }
    for (const [key, value] of Object.entries(overrides.inventory ?? {})) {
      if (!p.items.some((i) => i.id === key) || !Number.isInteger(value) || value < 0)
        throw new RuntimeError('测试道具数量无效。');
      s.inventory[key] = value;
    }
  }
  return enter(p, s, nodeId);
}
export function availableChoices(
  p: Project,
  s: RuntimeState,
): { choice: Choice; enabled: boolean }[] {
  return getScene(p, s)
    .choices.map((choice) => ({ choice, enabled: evaluate(choice.condition, s) }))
    .filter((x) => x.enabled || !x.choice.hiddenWhenLocked);
}
export function choose(p: Project, input: RuntimeState, choiceId: string): RuntimeState {
  if (input.phase !== 'choosing') throw new RuntimeError('当前不在选择阶段。');
  let s = copy(input);
  const n = getScene(p, s);
  const c = n.choices.find((c) => c.id === choiceId);
  if (!c || !evaluate(c.condition, s)) throw new RuntimeError('此选项尚未解锁。');
  s = events(p, s, 'exit');
  log(s, `选择：${c.label}`);
  if (!s.takenChoices.includes(c.id)) s.takenChoices.push(c.id);
  return enter(p, s, c.targetId);
}
export function finish(p: Project, input: RuntimeState): RuntimeState {
  let s = copy(input);
  const n = getScene(p, s);
  if (s.phase === 'ended') return s;
  s.positionMs = sceneDuration(p, n);
  s = events(p, s, 'time');
  s = events(p, s, 'complete');
  if (n.choices.length) {
    s.phase = 'choosing';
    return s;
  }
  if (n.nextId) {
    s = events(p, s, 'exit');
    return enter(p, s, n.nextId);
  }
  s.phase = 'ended';
  return s;
}
/** mediaPosition is clip-relative. */
export function advance(p: Project, input: RuntimeState, mediaPosition: number): RuntimeState {
  if (input.phase === 'ended') return input;
  const n = getScene(p, input);
  if (input.phase === 'choosing' && n.choiceMode === 'pause') return input;
  const duration = sceneDuration(p, n);
  const pauseAt = n.choiceMode === 'pause' && n.choices.length ? n.choicesAtMs : null;
  let s = copy(input);
  s.positionMs = Math.max(0, Math.min(duration, mediaPosition, pauseAt ?? duration));
  s = events(p, s, 'time');
  if (
    s.phase === 'playing' &&
    n.choices.length &&
    n.choicesAtMs !== null &&
    s.positionMs >= n.choicesAtMs
  )
    s.phase = 'choosing';
  if (s.positionMs >= duration) return finish(p, s);
  return s;
}

export interface SaveGame {
  formatVersion: 1;
  projectId: string;
  fingerprint: string;
  savedAt: string;
  state: RuntimeState;
}
function fingerprintScenes(p: Project, scenes: unknown[]): string {
  const text = JSON.stringify({
    scenes,
    variables: p.variables.map(({ hidden: _hidden, ...variable }) => variable),
    items: p.items,
    startNodeId: storyStartId(p),
    assets: p.assets.map((a) => ({ id: a.id, path: a.path, durationMs: a.durationMs })),
  });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
type LegacyFingerprint = 'countdown' | 'empty-choice-effects' | 'v1' | 'v2';

function projectFingerprint(p: Project, legacy?: LegacyFingerprint, countdown = false): string {
  return fingerprintScenes(
    p,
    // Editing the heading leaves the player's current choices and saved progress intact.
    p.scenes.map(({ choiceQuestion: _choiceQuestion, storyboardOverlay: _overlay, ...scene }) => {
      if (legacy === 'v1' || legacy === 'v2') {
        const { id, kind, title, notes, chapterId, settingIds: _settings, ...rest } = scene;
        const header = { id, kind, title, chapter: chapterTitle(p, chapterId) };
        if (legacy === 'v2') return { ...header, ...(countdown ? withLegacyTimeout(rest) : rest) };
        const { endingText, ...fields } = rest;
        return {
          ...header,
          description: kind === 'ending' ? endingText : notes,
          ...(countdown ? withLegacyTimeout(fields) : fields),
        };
      }
      // Legacy hashes depend on the original order of serialized fields.
      const {
        notes: _notes,
        chapterId: _chapter,
        storyboardPages: _pages,
        settingIds: _settingIds,
        ...playback
      } = scene;
      if (legacy === 'empty-choice-effects')
        playback.choices = playback.choices.map(
          ({ id, label, targetId, condition, lockedText, hiddenWhenLocked }) => ({
            id,
            label,
            targetId,
            condition,
            effects: [],
            lockedText,
            hiddenWhenLocked,
          }),
        );
      const fields = legacy ? withLegacyTimeout(playback) : playback;
      const pages = activeStoryboard(scene);
      return pages ? { ...fields, storyboardPages: pages } : fields;
    }),
  );
}
function withLegacyTimeout(scene: object) {
  return Object.fromEntries(
    Object.entries(scene).flatMap(([key, value]) =>
      key === 'choiceMode'
        ? [
            [key, value],
            ['timeoutMs', 0],
          ]
        : [[key, value]],
    ),
  );
}
export function fingerprint(p: Project): string {
  return projectFingerprint(p);
}
export function saveGame(p: Project, s: RuntimeState): SaveGame {
  return {
    formatVersion: 1,
    projectId: p.id,
    fingerprint: fingerprint(p),
    savedAt: new Date().toISOString(),
    state: copy(s),
  };
}
export function loadGame(p: Project, input: unknown): RuntimeState {
  const raw = input as SaveGame;
  const current = fingerprint(p);
  const migration =
    raw?.fingerprint !== current &&
    p.saveMigration?.targetFingerprint === current &&
    p.saveMigration.fingerprints.includes(raw?.fingerprint)
      ? p.saveMigration
      : undefined;
  if (
    !raw ||
    raw.formatVersion !== 1 ||
    raw.projectId !== p.id ||
    (raw.fingerprint !== current &&
      !migration &&
      raw.fingerprint !== projectFingerprint(p, 'countdown') &&
      raw.fingerprint !== projectFingerprint(p, 'empty-choice-effects') &&
      !(['v1', 'v2'] as const).some(
        (format) =>
          raw.fingerprint === projectFingerprint(p, format) ||
          raw.fingerprint === projectFingerprint(p, format, true),
      ))
  )
    throw new RuntimeError('存档与当前作品内容不兼容。请使用原版本作品。');
  let s = raw.state;
  if (
    !s ||
    !['playing', 'choosing', 'ended'].includes(s.phase) ||
    !Number.isFinite(s.positionMs) ||
    s.positionMs < 0 ||
    !Number.isInteger(s.visitSerial) ||
    s.visitSerial < 1 ||
    !Array.isArray(s.fired) ||
    !s.fired.every((x) => typeof x === 'string') ||
    !Array.isArray(s.visited) ||
    !s.visited.every((x) => typeof x === 'string') ||
    !Array.isArray(s.log) ||
    !s.log.every((x) => x && typeof x.message === 'string' && typeof x.nodeId === 'string') ||
    typeof raw.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.savedAt)) ||
    !s.variables ||
    typeof s.variables !== 'object' ||
    Array.isArray(s.variables) ||
    !s.inventory ||
    typeof s.inventory !== 'object' ||
    Array.isArray(s.inventory) ||
    (s.takenChoices !== undefined &&
      (!Array.isArray(s.takenChoices) || !s.takenChoices.every((x) => typeof x === 'string')))
  )
    throw new RuntimeError('存档内容损坏。');
  const n = getScene(p, s);
  if (
    (s.logSequence !== undefined && (!Number.isSafeInteger(s.logSequence) || s.logSequence < 0)) ||
    s.log.some(
      (entry) =>
        (entry.sequence !== undefined &&
          (!Number.isSafeInteger(entry.sequence) ||
            entry.sequence < 1 ||
            entry.sequence > (s.logSequence ?? 0))) ||
        (entry.notice !== undefined && !isRuntimeNotice(entry.notice)),
    )
  )
    throw new RuntimeError('存档提示记录无效。');
  const nodeIds = new Set(p.scenes.map((node) => node.id));
  const choiceIds = new Set(p.scenes.flatMap((node) => node.choices.map((c) => c.id)));
  if (
    !s.visited.includes(s.nodeId) ||
    s.visited.some((id) => !nodeIds.has(id)) ||
    (s.takenChoices ?? []).some((id) => !choiceIds.has(id)) ||
    s.log.some((entry) => !nodeIds.has(entry.nodeId))
  )
    throw new RuntimeError('存档剧情记录无效。');
  if (s.phase === 'choosing' && (n.kind !== 'video' || !n.choices.length))
    throw new RuntimeError('存档选择状态无效。');
  if (s.positionMs > sceneDuration(p, n) + 1) throw new RuntimeError('存档播放位置无效。');
  if (migration) {
    s = { ...s, variables: { ...s.variables } };
    for (const entry of migration.addVariables) {
      const definition = p.variables.find((variable) => variable.id === entry.id);
      if (!definition || (entry.sources.length && typeof definition.initial !== 'number'))
        throw new RuntimeError('存档迁移配置无效。');
      if (Object.hasOwn(s.variables, entry.id)) continue;
      if (entry.sources.length && typeof definition.initial === 'number') {
        const gained = entry.sources.reduce(
          (sum, source) => sum + ((s.inventory[source.itemId] ?? 0) > 0 ? source.value : 0),
          0,
        );
        s.variables[entry.id] = Math.min(definition.max ?? Infinity, definition.initial + gained);
      } else s.variables[entry.id] = definition.initial;
    }
  }
  for (const v of p.variables) {
    const val = s.variables?.[v.id];
    if (
      typeof val !== v.type ||
      (typeof val === 'number' &&
        (!Number.isFinite(val) ||
          (v.min !== undefined && val < v.min) ||
          (v.max !== undefined && val > v.max)))
    )
      throw new RuntimeError('存档属性无效。');
  }
  for (const i of p.items) {
    const num = s.inventory?.[i.id];
    if (!Number.isInteger(num) || num < 0) throw new RuntimeError('存档道具无效。');
  }
  const { choiceElapsedMs: _legacy, ...state } = s as RuntimeState & { choiceElapsedMs?: number };
  return copy({ ...state, takenChoices: state.takenChoices ?? [] }); // Never enter again on restore.
}
