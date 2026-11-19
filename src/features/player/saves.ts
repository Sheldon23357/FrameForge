import type { Project } from '../../../packages/domain/schema';
import {
  loadGame,
  saveGame,
  type RuntimeState,
  type SaveGame,
} from '../../../packages/runtime/engine';

export const MANUAL_SLOTS = 6;
export type SlotId = number | 'auto';
export interface SaveSlot {
  save: SaveGame;
  title: string;
  label?: string;
  playtimeMs?: number;
}
export interface SlotInfo {
  id: SlotId;
  status: 'empty' | 'ready' | 'incompatible' | 'corrupt';
  slot?: SaveSlot;
  error?: string;
}
export type SaveStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Keep the original three game slot keys, with a separate namespace for editor previews. */
export class SaveRepository {
  constructor(
    private storage: SaveStorage,
    private project: Project,
    private preview = false,
  ) {}
  private key(id: SlotId) {
    return `frameforge.${this.preview ? 'preview.' : ''}save.${this.project.id}.${id}`;
  }
  read(id: SlotId): SlotInfo {
    let slot: SaveSlot | undefined;
    try {
      const raw = this.storage.getItem(this.key(id));
      if (!raw) return { id, status: 'empty' };
      slot = JSON.parse(raw) as SaveSlot;
      this.validate(slot);
      return { id, status: 'ready', slot };
    } catch (e) {
      const error = e instanceof Error ? e.message : '存档内容损坏。';
      return {
        id,
        status: error.includes('不兼容') ? 'incompatible' : 'corrupt',
        slot:
          slot &&
          typeof slot.title === 'string' &&
          slot.save &&
          typeof slot.save.savedAt === 'string'
            ? slot
            : undefined,
        error,
      };
    }
  }
  list(): SlotInfo[] {
    return [this.read('auto'), ...Array.from({ length: MANUAL_SLOTS }, (_, i) => this.read(i))];
  }
  latest(): SaveSlot | undefined {
    return this.list()
      .filter((info) => info.status === 'ready')
      .map((info) => info.slot!)
      .sort((a, b) => Date.parse(b.save.savedAt) - Date.parse(a.save.savedAt))[0];
  }
  validate(value: unknown): SaveSlot {
    const slot = value as SaveSlot;
    if (
      !slot ||
      typeof slot !== 'object' ||
      typeof slot.title !== 'string' ||
      slot.title.length > 500 ||
      (slot.label !== undefined && (typeof slot.label !== 'string' || slot.label.length > 80)) ||
      (slot.playtimeMs !== undefined && (!Number.isFinite(slot.playtimeMs) || slot.playtimeMs < 0))
    )
      throw new Error('存档内容损坏。');
    loadGame(this.project, slot.save);
    return slot;
  }
  write(id: SlotId, state: RuntimeState, label = '', playtimeMs = 0): SaveSlot {
    const slot: SaveSlot = {
      save: saveGame(this.project, state),
      title: this.project.scenes.find((s) => s.id === state.nodeId)?.title ?? '',
      label: label.trim().slice(0, 80),
      playtimeMs,
    };
    this.store(id, slot);
    return slot;
  }
  private store(id: SlotId, slot: SaveSlot) {
    this.validate(slot);
    try {
      this.storage.setItem(this.key(id), JSON.stringify(slot));
    } catch {
      throw new Error('无法写入存档，存储空间可能已满或被禁用。原存档仍保留。');
    }
  }
  remove(id: SlotId) {
    try {
      this.storage.removeItem(this.key(id));
    } catch {
      throw new Error('无法删除存档，请检查存储权限。');
    }
  }
  export(id: SlotId): string {
    const info = this.read(id);
    if (info.status !== 'ready') throw new Error(info.error ?? '没有可导出的存档。');
    return JSON.stringify({ format: 'frameforge-save', version: 1, slot: info.slot }, null, 2);
  }
  import(id: number, text: string): SaveSlot {
    const slot = this.decode(text);
    this.store(id, slot);
    return slot;
  }
  decode(text: string): SaveSlot {
    if (text.length > 8_000_000) throw new Error('存档文件超过 8 MB 限制。');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('存档文件不是有效的 JSON。');
    }
    const envelope = raw as { format?: unknown; version?: unknown; slot?: unknown };
    if (!envelope || envelope.format !== 'frameforge-save' || envelope.version !== 1)
      throw new Error('不支持的存档文件格式。');
    return this.validate(envelope.slot);
  }
}
