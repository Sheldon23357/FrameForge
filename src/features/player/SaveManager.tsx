import { useRef, useState } from 'react';
import {
  Save as FloppyDisk,
  ChevronRight as CaretRight,
  Trash2 as Trash,
  Download as DownloadSimple,
  Upload as UploadSimple,
  CircleAlert as WarningCircle,
} from 'lucide-react';
import { chapterTitle, type Project } from '../../../packages/domain/schema';
import type { RuntimeState } from '../../../packages/runtime/engine';
import { Button, time } from '../../components/ui';
import { SaveRepository, type SaveSlot, type SlotId } from './saves';

export function SaveManager({
  project: p,
  repository,
  mode,
  state,
  playtimeMs,
  resolveThumbnail,
  onRestore,
  onSaved,
}: {
  project: Project;
  repository: SaveRepository;
  mode: 'save' | 'load';
  state: RuntimeState | null;
  playtimeMs: number;
  resolveThumbnail: (nodeId: string) => string;
  onRestore: (slot: SaveSlot) => void;
  onSaved: () => void;
}) {
  const [slots, setSlots] = useState(() => repository.list());
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{
    kind: 'save' | 'delete' | 'import';
    id: SlotId;
    text?: string;
  }>();
  const upload = useRef<HTMLInputElement>(null);
  const importingTo = useRef<number>(0);
  const refresh = () => setSlots(repository.list());
  const act = (kind: 'save' | 'delete' | 'import', id: SlotId, text?: string) => {
    try {
      setError('');
      if (kind === 'save' && state) {
        repository.write(id, state, '', playtimeMs);
        onSaved();
      }
      if (kind === 'delete') {
        repository.remove(id);
        refresh();
      }
      if (kind === 'import' && typeof id === 'number' && text) {
        repository.import(id, text);
        refresh();
      }
      setPending(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const exportSlot = (id: SlotId) => {
    try {
      const text = repository.export(id);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${p.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-${id === 'auto' ? 'auto' : `save-${id + 1}`}.frameforge-save.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      {error && (
        <p className="save-error" role="alert">
          <WarningCircle size={16} />
          {error}
        </p>
      )}
      {pending && (
        <div className="save-confirmation" role="group" aria-label="存档操作确认">
          <strong>{pending.kind === 'delete' ? '确认删除此存档？' : '确认覆盖已有存档？'}</strong>
          <div>
            <Button onClick={() => setPending(undefined)}>取消操作</Button>
            <Button
              variant={pending.kind === 'delete' ? 'danger' : 'primary'}
              onClick={() => act(pending.kind, pending.id, pending.text)}
            >
              {pending.kind === 'delete' ? '确认删除' : '确认覆盖'}
            </Button>
          </div>
        </div>
      )}
      <div className="save-slots enhanced-slots" inert={pending ? true : undefined}>
        {slots.map((info) => {
          const auto = info.id === 'auto';
          const number = auto ? 'AUTO' : String((info.id as number) + 1).padStart(2, '0');
          const slot = info.slot;
          const scene = p.scenes.find((s) => s.id === slot?.save?.state?.nodeId);
          const thumbnail = info.status === 'ready' && scene ? resolveThumbnail(scene.id) : '';
          const title =
            info.status === 'empty'
              ? '空存档'
              : info.status === 'corrupt'
                ? '存档损坏'
                : slot?.label || slot?.title || '已有存档';
          const date =
            slot?.save.savedAt && Number.isFinite(Date.parse(slot.save.savedAt))
              ? new Date(slot.save.savedAt).toLocaleString('zh-CN', { hour12: false })
              : '';
          return (
            <div
              className={`save-slot-row ${auto ? 'automatic' : ''} ${info.status}`}
              key={info.id}
            >
              <button
                className="save-slot"
                disabled={mode === 'load' ? info.status !== 'ready' : auto || !state}
                onClick={() => {
                  setError('');
                  if (mode === 'load' && slot) {
                    try {
                      onRestore(repository.validate(slot));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  } else if (info.status === 'empty') act('save', info.id);
                  else setPending({ kind: 'save', id: info.id });
                }}
              >
                <span className="slot-number">{number}</span>
                <span className="slot-thumbnail">
                  {thumbnail ? <img alt="" src={thumbnail} /> : <FloppyDisk size={22} />}
                </span>
                <span className="slot-copy">
                  <strong>{auto ? `自动存档 · ${title}` : title}</strong>
                  {scene && (
                    <span>
                      {chapterTitle(p, scene.chapterId)} · {time(slot?.save.state.positionMs ?? 0)}
                    </span>
                  )}
                  {!!date && (
                    <span>
                      {date}
                      {slot?.playtimeMs ? ` · 游玩 ${time(slot.playtimeMs)}` : ''}
                    </span>
                  )}
                  {info.status === 'incompatible' && (
                    <span className="save-error">与当前作品版本不兼容</span>
                  )}
                  {info.status === 'corrupt' && <span className="save-error">{info.error}</span>}
                </span>
                {mode === 'save' ? <FloppyDisk size={17} /> : <CaretRight size={17} />}
              </button>
              <div className="slot-actions">
                <Button
                  aria-label={`导出存档 ${number}`}
                  disabled={info.status !== 'ready'}
                  onClick={() => exportSlot(info.id)}
                >
                  <DownloadSimple size={17} />
                  导出
                </Button>
                {!auto && (
                  <Button
                    aria-label={`导入到存档 ${number}`}
                    onClick={() => {
                      importingTo.current = info.id as number;
                      upload.current?.click();
                    }}
                  >
                    <UploadSimple size={17} />
                    导入
                  </Button>
                )}
                <Button
                  aria-label={`删除存档 ${number}`}
                  disabled={info.status === 'empty'}
                  onClick={() => setPending({ kind: 'delete', id: info.id })}
                >
                  <Trash size={17} />
                  删除
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <input
        ref={upload}
        hidden
        type="file"
        accept=".json,.frameforge-save"
        aria-label="导入存档文件"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            if (file.size > 8_000_000) throw new Error('存档文件超过 8 MB 限制。');
            const text = await file.text();
            repository.decode(text);
            const id = importingTo.current;
            if (repository.read(id).status === 'empty') act('import', id, text);
            else setPending({ kind: 'import', id, text });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </>
  );
}
