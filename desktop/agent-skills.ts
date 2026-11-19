import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';
import {
  skillNameSchema,
  skillReadSchema,
  type SkillCatalog,
  type SkillInfo,
  type SkillReadResult,
} from '../packages/agent/skills';
import { atomicWrite } from './files';

const maxFileBytes = 256 * 1024;
const maxSkillBytes = 2 * 1024 * 1024;
const maxCatalogBytes = 12 * 1024 * 1024;
const maxSkills = 128;
const validText = /\.(md|txt|json|ya?ml|csv|tsv)$/i;
const metadataSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
});

type Skill = SkillInfo & { directory: string; files: Map<string, string> };
type Snapshot = { catalog: SkillCatalog; skills: Map<string, Skill> };

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function entries(folder: string) {
  const stat = await fs.lstat(folder).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return [];
  if (path.relative(folder, await fs.realpath(folder))) return [];
  const rows = [];
  for await (const entry of await fs.opendir(folder)) {
    if (rows.length >= 1024) throw new Error('目录条目超过扫描上限。');
    rows.push(entry);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

async function readText(file: string) {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    path.relative(file, await fs.realpath(file))
  )
    throw new Error('只允许读取技能目录中的普通文本文件。');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    )
      throw new Error('技能文件在读取时发生变化。');
    if (opened.size > maxFileBytes) throw new Error('技能文件超过大小上限。');
    const data = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== opened.size) throw new Error('技能文件在读取时发生变化。');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead));
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error('技能资料不是普通文本。');
    return content;
  } finally {
    await handle.close();
  }
}

async function readSkill(directory: string, bytesAvailable: number) {
  const entry = await readText(path.join(directory, 'SKILL.md'));
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(entry);
  if (!frontmatter || frontmatter[1].length > 8192) throw new Error('缺少有效的 YAML 元数据。');
  const metadata = metadataSchema.safeParse(load(frontmatter[1], { schema: JSON_SCHEMA }));
  if (!metadata.success || metadata.data.name !== path.basename(directory))
    throw new Error('技能名称须与目录一致，并提供有效的用途说明。');
  const files = new Map([['SKILL.md', entry]]);
  let size = Buffer.byteLength(entry);
  const limit = Math.min(bytesAvailable, maxSkillBytes);
  const warnings: string[] = [];
  let folders = 0;
  if (size > limit) throw new Error('技能资料超过加载上限。');
  const visit = async (relative: string, depth: number) => {
    if (++folders > 256) throw new Error('技能资料目录数量超过上限。');
    for (const item of await entries(path.join(directory, relative))) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const name = relative + '/' + item.name;
      if (item.isDirectory() && depth < 5) await visit(name, depth + 1);
      if (!item.isFile() || !validText.test(name) || name.length > 300) continue;
      if (files.size >= 256) throw new Error('技能资料文件数量超过上限。');
      let content: string;
      try {
        content = await readText(path.join(directory, name));
      } catch {
        warnings.push(name);
        continue;
      }
      size += Buffer.byteLength(content);
      if (size > limit) throw new Error('技能资料超过加载上限。');
      files.set(name, content);
    }
  };
  for (const folder of ['references', 'assets']) await visit(folder, 1);
  for (const item of await entries(directory)) {
    if (
      item.name === 'SKILL.md' ||
      item.name.startsWith('.') ||
      !item.isFile() ||
      !/\.(md|txt)$/i.test(item.name)
    )
      continue;
    const content = await readText(path.join(directory, item.name));
    size += Buffer.byteLength(content);
    if (files.size >= 256 || size > limit) throw new Error('技能资料超过加载上限。');
    files.set(item.name, content);
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([...files]))
    .digest('hex');
  return { skill: { ...metadata.data, digest, directory, files }, size, warnings };
}

function page<T>(items: T[], offset: number, limit: number) {
  const next = Math.min(items.length, offset + limit);
  return {
    items: items.slice(offset, next),
    total: items.length,
    nextOffset: next < items.length ? next : null,
    truncated: next < items.length,
  };
}

const modelInfo = ({ name, description, digest }: Skill): SkillInfo => ({
  name,
  description,
  digest,
});
const preferencesSchema = z.object({
  root: z.string().max(4096).refine(path.isAbsolute),
  locations: z.record(skillNameSchema, z.string().max(4096)).optional(),
});

export class AgentSkillService {
  private snapshot?: Promise<Snapshot>;
  private config: string;
  private defaultRoot: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(userData: string, defaultRoot = path.join(userData, 'skills')) {
    this.defaultRoot = defaultRoot;
    this.config = path.join(userData, 'agent-skills.json');
  }

  async refresh(root?: string) {
    const task = this.queue.then(async () => {
      const snapshot = await this.scan(root, await this.snapshot);
      await atomicWrite(
        this.config,
        JSON.stringify({
          root: snapshot.catalog.root,
          locations: Object.fromEntries(
            snapshot.catalog.skills.map(({ name, directory }) => [name, directory]),
          ),
        }),
      );
      this.snapshot = Promise.resolve(snapshot);
      return snapshot.catalog;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async current() {
    await this.queue;
    this.snapshot ??= this.scan();
    return this.snapshot;
  }

  private async scan(chosenRoot?: string, previous?: Snapshot): Promise<Snapshot> {
    const skills = new Map<string, Skill>();
    const issues: string[] = [];
    const report = (message: string) => {
      if (issues.length < 100) issues.push(message);
    };
    let root = chosenRoot ?? this.defaultRoot;
    let locations: Record<string, string> | undefined;
    try {
      const config =
        !chosenRoot &&
        (await fs.readFile(this.config, 'utf8').catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        }));
      if (config) {
        const value = preferencesSchema.parse(JSON.parse(config));
        root = value.root;
        locations = value.locations;
      }
      if (root === this.defaultRoot) await fs.mkdir(root, { recursive: true });
    } catch {
      report('技能目录设置无法读取，请重新选择目录。');
      return { skills, catalog: { root, issues, skills: [] } };
    }
    let used = 0;
    try {
      const canonical = await fs.realpath(root);
      const candidates = new Set<string>();
      const inspect = async (folder: string) => {
        const rows = await entries(folder);
        if (rows.some((entry) => entry.name === 'SKILL.md')) candidates.add(folder);
        return rows;
      };
      const folders = (await inspect(canonical)).filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
      );
      for (const folder of folders) {
        const child = path.join(canonical, folder.name);
        const rows = await inspect(child).catch(() => {
          report(`${child}：目录无法扫描。`);
          return [];
        });
        if (rows.some((entry) => entry.name === 'SKILL.md')) continue;
        const nested = folder.name === 'skills' ? child : path.join(child, 'skills');
        const nestedRows = await entries(nested).catch(() => {
          report(`${nested}：目录无法扫描。`);
          return [];
        });
        for (const entry of nestedRows)
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const candidate = path.join(nested, entry.name);
            await inspect(candidate).catch(() => report(`${candidate}：目录无法扫描。`));
            if (candidates.size >= maxSkills * 2) break;
          }
        if (candidates.size >= maxSkills * 2) break;
      }
      const priority = (dir: string) => {
        const name = path.basename(dir);
        return Number((previous?.skills.get(name)?.directory ?? locations?.[name]) === dir);
      };
      const sorted = [...candidates].sort((a, b) => priority(b) - priority(a));
      for (const directory of sorted) {
        if (skills.size >= maxSkills) {
          report('技能数量达到扫描上限。');
          break;
        }
        const name = path.basename(directory);
        const existing = skills.get(name);
        if (existing) {
          report(`技能同名：${directory}。正在使用 ${existing.directory}。`);
          continue;
        }
        try {
          const { skill, size, warnings } = await readSkill(directory, maxCatalogBytes - used);
          skills.set(name, skill);
          used += size;
          for (const file of warnings) report(`${name}/${file}：无法读取或超过文件大小限制。`);
        } catch (error) {
          const message =
            error instanceof Error && error.name === 'Error'
              ? error.message.split('\n')[0]
              : '技能文件格式无效或无法读取。';
          report(`${directory}：${message}`);
        }
      }
    } catch {
      report('技能目录无法扫描，请检查路径、访问权限和目录大小。');
    }
    return {
      skills,
      catalog: {
        root,
        issues,
        skills: [...skills.values()].map((skill) => ({
          ...modelInfo(skill),
          directory: skill.directory,
        })),
      },
    };
  }
}

// Each editor window owns its runs. A refresh replaces the catalog; active runs keep their snapshot.
export class AgentSkillRuns {
  private runs = new Map<string, Promise<Snapshot>>();
  constructor(private service: AgentSkillService) {}

  async begin(runId: string) {
    if (!/^run_[a-zA-Z0-9_-]{1,100}$/.test(runId) || this.runs.size >= 2 || this.runs.has(runId))
      throw new Error('无法创建技能读取会话。');
    const pending = this.service.current();
    this.runs.set(runId, pending);
    const snapshot = await pending;
    return [...snapshot.skills.values()].map(modelInfo);
  }

  cancel(runId: string) {
    this.runs.delete(runId);
  }

  cancelAll() {
    this.runs.clear();
  }

  async preview(raw: unknown) {
    const input = skillReadSchema.parse(raw);
    if (input.action !== 'open') throw new Error('这里只能预览技能正文。');
    const runId = 'run_preview_' + crypto.randomUUID();
    try {
      await this.begin(runId);
      return await this.read(runId, input);
    } finally {
      this.cancel(runId);
    }
  }

  async read(runId: string, raw: unknown): Promise<SkillReadResult> {
    const input = skillReadSchema.parse(raw);
    const pending = this.runs.get(runId);
    if (!pending) throw new Error('技能读取会话已结束。');
    const { skills } = await pending;
    if (this.runs.get(runId) !== pending) throw new Error('技能读取会话已结束。');
    if (input.action === 'search') {
      const query = input.query.toLowerCase();
      return page(
        [...skills.values()]
          .filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query))
          .map(modelInfo),
        input.offset,
        6,
      );
    }
    const skill = skills.get(input.name);
    if (!skill) throw new Error('本轮目录里没有这个技能。请先检索技能名称。');
    const identity = { name: skill.name, digest: skill.digest };
    if (input.action === 'list_files')
      return {
        identity,
        ...page(
          [...skill.files.keys()].filter((f) =>
            f.toLowerCase().includes(input.query.toLowerCase()),
          ),
          input.offset,
          20,
        ),
      };
    const file = input.action === 'open' ? 'SKILL.md' : input.file.replaceAll('\\', '/');
    const content = skill.files.get(file);
    if (content === undefined) throw new Error('本轮技能没有这份可读资料。请用 list_files 查找。');
    let end = Math.min(content.length, input.offset + 4800);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    return {
      identity,
      file,
      text: content.slice(input.offset, end),
      total: content.length,
      nextOffset: end < content.length ? end : null,
      truncated: end < content.length,
    };
  }
}
