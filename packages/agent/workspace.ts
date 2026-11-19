import type { Project } from '../domain/schema';
import { reachableStoryNodes } from '../domain/story-graph';
import { storyOverviewNode } from './tools/story';
import {
  coversDesign,
  designPage,
  missingDesignRanges,
  nextDesignOffset,
  type DesignPage,
} from './design-read-coverage';
import type { ModelExchange, ToolResult } from './types';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;

const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => {
    const row = record(entry);
    return row
      ? Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((key) => [key, row[key]]),
        )
      : entry;
  });

type Facts = [string, unknown][];
interface Observation {
  facts: Map<string, string>;
  designs: DesignPage[];
  exchange: ModelExchange;
}

export function readItems(
  name: string,
  query: Row,
  result: ToolResult,
): { name: string; query: Row; data: Row }[] {
  const data = record(result.data);
  if (!result.ok || !data || data.reused === true || 'originalCharacters' in data) return [];
  if (name !== 'read_batch') return [{ name, query, data }];
  const requests = Array.isArray(query.requests) ? query.requests : [];
  return (Array.isArray(data.results) ? data.results : []).flatMap(
    (child: ToolResult & { index: number; tool: string }) => {
      const request = record(requests[child.index]);
      const args = record(request?.args);
      return args && request?.tool === child.tool ? readItems(child.tool, args, child) : [];
    },
  );
}

function designPages(name: string, query: Row, result: ToolResult) {
  return readItems(name, query, result).flatMap((item) => {
    const page = item.name === 'read_story_design' ? designPage(item.query, item.data) : undefined;
    return page ? [page] : [];
  });
}

function queryArgs(query: Row) {
  return record(query.args) ?? query;
}

/** Address story data by node and field, independent of query pagination and argument shape. */
function factsFor(name: string, query: Row, result: ToolResult): Facts {
  const data = record(result.data);
  if (!result.ok || !data || data.reused === true || 'originalCharacters' in data) return [];
  if (name === 'read_batch' && Array.isArray(data.results) && Array.isArray(query.requests)) {
    const requests = query.requests;
    return data.results.flatMap((child: ToolResult & { index: number; tool: string }) => {
      const args = record(record(requests[child.index])?.args);
      return args ? factsFor(child.tool, args, child) : [];
    });
  }
  if (name === 'read_story_design') return [];
  if (name === 'read_world_settings') {
    const { offset: _offset, limit: _limit, ...filter } = query;
    const key = json([name, filter]);
    const facts: Facts = [[key, data.total]];
    if (data.setting) facts.push([json([name, 'detail', record(data.setting)?.id]), data.setting]);
    const rows = Array.isArray(data.settings) ? data.settings : data.nodes;
    if (Array.isArray(rows)) {
      rows.forEach((row, index) => facts.push([`${key}:${Number(data.offset ?? 0) + index}`, row]));
    }
    return facts;
  }
  if (name !== 'read_story') return [[json([name, query]), data]];
  const args = queryArgs(query);
  if (query.action === 'playback') {
    const facts: Facts = [[json([name, query.action, args]), data]];
    for (const node of Array.isArray(data.nodes) ? (data.nodes as Row[]) : []) {
      if (!Array.isArray(node.storyboardPages)) continue;
      const prefix = `node:${node.id}`;
      node.storyboardPages.forEach(({ text, durationMs }: Row, index: number) =>
        facts.push([`${prefix}:page:${index}`, [text, durationMs]]),
      );
      facts.push([`${prefix}:page-count`, node.storyboardPages.length]);
    }
    return facts;
  }
  if (['timeline', 'shots', 'shot'].includes(String(query.action)))
    return [[json([name, query.action, args]), data]];
  const facts: Facts = [];
  if (Array.isArray(data.nodes)) {
    for (const node of data.nodes as Row[]) {
      const prefix = `node:${node.id}`;
      if (query.action === 'list') {
        facts.push([`${prefix}:list`, node]);
        continue;
      }
      const choices = Array.isArray(node.choices) ? node.choices : [];
      facts.push([
        `${prefix}:links`,
        {
          id: node.id,
          title: node.title,
          kind: node.kind,
          chapterId: node.chapterId,
          nextId: node.nextId || undefined,
          choiceCount: node.choiceCount ?? choices.length + Number(node.moreChoices ?? 0),
          choices: choices.map((choice) =>
            Array.isArray(choice) ? choice : [choice.id, choice.label, choice.targetId],
          ),
        },
      ]);
      if (Array.isArray(node.pages)) {
        const durations = node.pageDurationsMs as number[] | undefined;
        node.pages.forEach((text, index) =>
          facts.push([`${prefix}:page:${index}`, [text, durations?.[index]]]),
        );
        facts.push([`${prefix}:page-count`, node.pages.length]);
      }
      if (node.ending !== undefined) facts.push([`${prefix}:ending`, node.ending]);
    }
    for (const entry of Array.isArray(data.chapters) ? (data.chapters as Row[]) : [])
      facts.push([`chapter:${entry.id}:start`, entry.startNodeId]);
    if ('startNodeId' in data) facts.push(['story:start', data.startNodeId]);
    return facts;
  }
  if (query.action === 'read' && args.section === 'storyboard' && Array.isArray(data.pages)) {
    const prefix = `node:${data.id}`;
    const offset = Number(data.offset ?? 0);
    for (const [index, page] of (data.pages as Row[]).entries())
      facts.push([`${prefix}:page:${offset + index}`, [page.text, page.durationMs]]);
    facts.push([`${prefix}:page-count`, data.total]);
    return facts;
  }
  if (query.action === 'read') {
    const section = args.section ?? 'all';
    return [
      [
        json([name, 'read', args.nodeId, section, section === 'all' ? 0 : (args.offset ?? 0)]),
        data,
      ],
    ];
  }
  return [[json([name, query]), data]];
}

export class AgentWorkspace {
  private readonly facts = new Map<string, string>();
  private readonly reads: Observation[] = [];
  private contextFacts = new Map<string, string>();
  private carriedFacts = new Map<string, string>();
  private carriedDesigns: DesignPage[] = [];
  private readonly storyIds = new Set<string>();
  private scope?: string;
  hasCompleteStory = false;
  hasCompleteChapter = false;

  observe(name: string, query: Row, result: ToolResult, exchange: ModelExchange) {
    const facts = factsFor(name, query, result);
    const designs = designPages(name, query, result);
    const seen = new Map<string, string>();
    let fresh = false;
    for (const [id, value] of facts) {
      const fingerprint = json(value);
      seen.set(id, fingerprint);
      if (this.facts.get(id) !== fingerprint) fresh = true;
      this.facts.set(id, fingerprint);
      if (id.startsWith('node:')) this.storyIds.add(id.split(':')[1]);
    }
    for (const page of designs) {
      if (
        !coversDesign(
          page,
          this.reads.flatMap((read) => read.designs),
        )
      )
        fresh = true;
    }
    if (facts.length || designs.length) {
      this.reads.push({ facts: seen, designs, exchange });
    }
    return fresh;
  }

  wasVisible(
    name: string,
    query: Row,
    result: ToolResult,
    exchanges: readonly ModelExchange[],
  ): boolean {
    if (name === 'read_batch') {
      const data = record(result.data);
      const requests = Array.isArray(query.requests) ? query.requests : [];
      return (
        !data?.truncated &&
        Array.isArray(data?.results) &&
        data.results.length > 0 &&
        data.results.every((child: ToolResult & { index: number; tool: string }) => {
          const args = record(record(requests[child.index])?.args);
          return args && this.wasVisible(child.tool, args, child, exchanges);
        })
      );
    }
    const facts = factsFor(name, query, result);
    const pages = designPages(name, query, result);
    if (pages.length) {
      const visible = this.visibleDesigns(exchanges);
      return pages.every((page) => coversDesign(page, visible));
    }
    if (!facts.length) return false;
    const visible = this.visibleReads(exchanges);
    return facts.every(([id, value]) => {
      const fingerprint = json(value);
      return (
        this.contextFacts.get(id) === fingerprint ||
        this.carriedFacts.get(id) === fingerprint ||
        visible.some((read) => read.facts.get(id) === fingerprint)
      );
    });
  }

  setCarriedReads(reads: readonly { tool: string; query?: Row; data: Row }[]) {
    this.carriedFacts.clear();
    this.carriedDesigns = [];
    for (const { tool, query = {}, data } of reads) {
      const result = { ok: true, summary: '', data };
      for (const [key, value] of factsFor(tool, query, result))
        this.carriedFacts.set(key, json(value));
      this.carriedDesigns.push(...designPages(tool, query, result));
    }
  }

  private visibleReads(exchanges: readonly ModelExchange[]) {
    const visible = new Set(exchanges);
    return this.reads.filter((read) => visible.has(read.exchange));
  }

  private visibleDesigns(exchanges: readonly ModelExchange[]) {
    return [
      ...this.carriedDesigns,
      ...this.visibleReads(exchanges).flatMap((read) => read.designs),
    ];
  }

  designReadCursor(query: Row, result: ToolResult, exchanges: readonly ModelExchange[]) {
    const data = record(result.data);
    const [page] = designPages('read_story_design', query, result);
    return page && typeof data?.nextOffset === 'number'
      ? nextDesignOffset(page, data.nextOffset, this.visibleDesigns(exchanges))
      : data?.nextOffset;
  }

  omitVisibleDesignText(query: Row, result: ToolResult, exchanges: readonly ModelExchange[]) {
    const [page] = designPages('read_story_design', query, result);
    if (!page?.text.length) return result;
    const visible = this.visibleDesigns(exchanges);
    const [missing] = missingDesignRanges(page, visible);
    if (!missing) return result;
    const nextOffset = nextDesignOffset(page, missing.end, visible);
    const data = record(result.data)!;
    if (
      missing.start === page.offset &&
      missing.end === page.offset + page.text.length &&
      nextOffset === data.nextOffset
    )
      return result;
    return {
      ...result,
      summary: `${result.summary}（仅返回尚未提供的正文范围）`,
      data: {
        ...data,
        offset: missing.start,
        text: page.text.slice(missing.start - page.offset, missing.end - page.offset),
        nextOffset,
        truncated: nextOffset !== null,
      },
    };
  }

  reuseBatchRead(
    name: string,
    query: Row,
    result: ToolResult,
    exchanges: readonly ModelExchange[],
  ) {
    const data = record(result.data);
    if (data?.truncated && name !== 'read_story_design') return result;
    if (!this.wasVisible(name, query, result, exchanges))
      return name === 'read_story_design'
        ? this.omitVisibleDesignText(query, result, exchanges)
        : result;
    return {
      ok: true,
      summary: '该范围已提供，请复用已有结果。',
      data: {
        reused: true,
        ...(data && 'nextOffset' in data
          ? {
              nextOffset:
                name === 'read_story_design'
                  ? this.designReadCursor(query, result, exchanges)
                  : data.nextOffset,
            }
          : {}),
      },
    };
  }

  snapshot(project: Project, budget: number, selectedIds: string[], chapterId?: string) {
    const byId = new Map(project.scenes.map((node) => [node.id, node]));
    const chapterRows = project.chapters.map(({ id, title, startNodeId }) => ({
      id,
      title,
      startNodeId,
    }));
    const ids = new Set([
      ...selectedIds,
      ...project.scenes
        .filter((node) => chapterId && node.chapterId === chapterId)
        .map(({ id }) => id),
      ...this.storyIds,
      ...byId.keys(),
    ]);
    const nodes: ReturnType<typeof storyOverviewNode>[] = [];
    const snapshot = {
      startNodeId: project.startNodeId,
      chapters: chapterRows,
      totalNodes: byId.size,
      nodes,
    };
    this.scope = chapterId;
    let remaining = budget - JSON.stringify(snapshot).length - 48;
    for (const id of ids) {
      const source = byId.get(id);
      if (!source) continue;
      const row = storyOverviewNode(source);
      const size = JSON.stringify(row).length + 1;
      if (size > remaining) continue;
      remaining -= size;
      nodes.push(row);
    }
    this.contextFacts = new Map(
      factsFor(
        'read_story',
        { action: 'overview' },
        {
          ok: true,
          summary: '',
          data: snapshot,
        },
      )
        .filter(() => nodes.length > 0)
        .map(([key, value]) => [key, json(value)]),
    );
    for (const [key, value] of this.contextFacts) this.facts.set(key, value);
    this.hasCompleteStory = nodes.length > 0 && nodes.length === byId.size;
    this.hasCompleteChapter = Boolean(this.describeCoverage(project));
    return nodes.length ? snapshot : undefined;
  }

  // Use the model-visible payload, never a truncated value from the audit trail.
  canReplace(exchange: ModelExchange) {
    return (
      exchange.replies.length > 0 &&
      exchange.replies.every(({ call, result }) => {
        if (!result.ok) return false;
        const query = record(JSON.parse(call.arguments));
        if (!query) return false;
        if (['read_story_design', 'read_world_settings', 'read_batch'].includes(call.name))
          return this.wasVisible(call.name, query, result, []);
        if (call.name !== 'read_story') return false;
        if (!['overview', 'topology', 'read'].includes(String(query.action))) return false;
        const facts = factsFor(call.name, query, result);
        return (
          facts.length > 0 &&
          facts.every(([key, value]) => this.contextFacts.get(key) === json(value))
        );
      })
    );
  }

  describeCoverage(project: Project) {
    const chapter = project.chapters.find(({ id }) => id === this.scope);
    const ids = project.scenes
      .filter(({ chapterId }) => chapterId === chapter?.id)
      .map(({ id }) => id);
    return ids.length && ids.every((id) => this.contextFacts.has(`node:${id}:links`))
      ? `已完整载入当前章节「${chapter!.title}」的节点与出边。`
      : '';
  }
}

export function disconnectedChanges(base: Project, draft: Project) {
  const reachable = (project: Project) => {
    const index = new Map(project.scenes.map((node) => [node.id, node]));
    return reachableStoryNodes(index, [
      project.startNodeId,
      ...project.chapters.map(({ startNodeId }) => startNodeId),
    ]);
  };
  const before = reachable(base);
  const after = reachable(draft);
  const oldIds = new Set(base.scenes.map(({ id }) => id));
  return draft.scenes
    .filter(({ id }) => !after.has(id) && (before.has(id) || !oldIds.has(id)))
    .map(({ id, title }) => ({ id, title }));
}
