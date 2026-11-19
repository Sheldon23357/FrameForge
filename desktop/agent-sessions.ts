import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWrite } from './files';
import { sessionSchema, type AgentSession, type SessionInfo } from '../packages/agent/types';
import { creativeDraftSchema, type CreativeDraft } from '../packages/agent/creative-state';

const CHAT_BYTES = 16_000_000;
const CHECKPOINT_BYTES = 40_000_000;
const BASE_BYTES = 90_000_000; // A 30-million-character project can use up to 90 MB in UTF-8.

export class AgentSessionService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private userData: string) {}
  private directory(projectId: string) {
    if (!projectId || projectId.length > 160) throw new Error('工程 ID 无效。');
    return path.join(
      this.userData,
      'agent-sessions',
      createHash('sha256').update(projectId).digest('hex'),
    );
  }
  private file(projectId: string, sessionId: string) {
    if (!/^chat_[a-zA-Z0-9_-]{1,95}$/.test(sessionId)) throw new Error('对话 ID 无效。');
    return path.join(this.directory(projectId), `${sessionId}.json`);
  }
  async loadCreativeDraft(projectId: string) {
    await this.queue;
    const file = path.join(this.directory(projectId), 'creative-draft.json');
    try {
      const stat = await fs.stat(file);
      if (stat.size > 256_000) throw new Error('创作草案超出大小限制。');
      return creativeDraftSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async saveCreativeDraft(projectId: string, draft: CreativeDraft) {
    const text = JSON.stringify(creativeDraftSchema.parse(draft));
    if (Buffer.byteLength(text) > 256_000) throw new Error('创作草案超出大小限制。');
    const file = path.join(this.directory(projectId), 'creative-draft.json');
    const task = this.queue.then(() => atomicWrite(file, text));
    this.queue = task.catch(() => {});
    await task;
  }
  async load(projectId: string, sessionId: string): Promise<AgentSession | null> {
    const file = this.file(projectId, sessionId);
    const task = this.queue.then(async () => {
      try {
        const stat = await fs.stat(file);
        if (stat.size > CHAT_BYTES + CHECKPOINT_BYTES + BASE_BYTES + 32)
          throw new Error('对话记录超过大小限制。');
        const session = sessionSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
        if (session.projectId !== projectId || session.id !== sessionId)
          throw new Error('对话归属不匹配。');
        return session;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('对话记录无法读取或版本不兼容，原文件已保留。');
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async list(projectId: string): Promise<SessionInfo[]> {
    const dir = this.directory(projectId);
    await this.queue;
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: SessionInfo[] = [];
    for (const file of files.filter((f) => /^chat_[a-zA-Z0-9_-]+\.json$/.test(f)).slice(0, 1000)) {
      try {
        const s = await this.load(projectId, file.slice(0, -5));
        if (s)
          rows.push({
            id: s.id,
            projectId: s.projectId,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          });
      } catch {
        /* Keep corrupt files untouched; other chats remain usable. */
      }
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async save(input: AgentSession) {
    const parsed = sessionSchema.safeParse(input);
    if (!parsed.success) throw new Error('对话记录格式无效，无法保存。');
    const { checkpoint, suspendedCheckpoints, ...chat } = parsed.data;
    if (Buffer.byteLength(JSON.stringify(chat)) > CHAT_BYTES)
      throw new Error('对话记录超过 16 MB，请新建对话。');
    if (checkpoint) {
      const { baseProject, ...draft } = checkpoint;
      if (Buffer.byteLength(JSON.stringify(draft)) > CHECKPOINT_BYTES)
        throw new Error('创作草稿超过 40 MB，无法保存当前进度。');
      if (baseProject && Buffer.byteLength(JSON.stringify(baseProject)) >= BASE_BYTES - 32)
        throw new Error('草稿基准超过大小限制，无法保存当前进度。');
    }
    const text = JSON.stringify(parsed.data);
    if (Buffer.byteLength(text) > CHAT_BYTES + CHECKPOINT_BYTES + BASE_BYTES + 32)
      throw new Error('待续跑任务的工程快照超出存储上限，请先完成一个待办。');
    const file = this.file(parsed.data.projectId, parsed.data.id);
    const task = this.queue.then(() => atomicWrite(file, text));
    this.queue = task.catch(() => {});
    await task;
  }
  async delete(projectId: string, sessionId: string) {
    const file = this.file(projectId, sessionId);
    const task = this.queue.then(() =>
      fs.unlink(file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }),
    );
    this.queue = task.catch(() => {});
    await task;
  }
}
