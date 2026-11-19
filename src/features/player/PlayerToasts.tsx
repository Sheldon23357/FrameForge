import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, Backpack, SlidersHorizontal } from 'lucide-react';
import { Button } from '../../components/ui';
import type { RuntimeNotice } from '../../../packages/runtime/notifications';
import type { Value } from '../../../packages/domain/schema';

export type PlayerNotice = RuntimeNotice | { kind: 'info' | 'error'; message: string };
export type ChangeNotice = Extract<RuntimeNotice, { kind: 'item' | 'variable' }>;
export const isChangeNotice = (notice: PlayerNotice): notice is ChangeNotice =>
  notice.kind === 'item' || notice.kind === 'variable';
type Toast = { id: number; notice: PlayerNotice };
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 10 });
const valueText = (value: Value) =>
  typeof value === 'boolean'
    ? value
      ? '开启'
      : '关闭'
    : typeof value === 'number'
      ? number.format(value)
      : value || '空';

export function describeNotice(notice: PlayerNotice): { title: string; detail?: string } {
  if (notice.kind === 'message') return { title: notice.name, detail: notice.text };
  if (notice.kind === 'event') return { title: `事件触发：${notice.name || '未命名事件'}` };
  if (notice.kind === 'item')
    return {
      title: `${notice.delta > 0 ? '获得' : '消耗'} ${notice.name} × ${Math.abs(notice.delta)}`,
      detail: `现有数量 × ${notice.total}`,
    };
  if (notice.kind === 'variable') {
    const delta =
      typeof notice.before === 'number' && typeof notice.after === 'number'
        ? notice.after - notice.before
        : null;
    return {
      title:
        delta === null
          ? `${notice.name}已更新`
          : `${notice.name} ${delta > 0 ? '+' : ''}${number.format(delta)}`,
      detail: `${valueText(notice.before)} → ${valueText(notice.after)}`,
    };
  }
  return { title: notice.message };
}

export function usePlayerToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const notify = useCallback((notices: PlayerNotice[]) => {
    if (!notices.length) return;
    const additions = notices.map((notice) => ({ id: ++nextId.current, notice }));
    setToasts((current) => [...current, ...additions]);
  }, []);
  const clear = useCallback(() => setToasts([]), []);
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );
  return { toasts, notify, clear, dismiss };
}

export function PlayerToasts({
  toasts,
  paused,
  dismiss,
  container,
}: {
  toasts: Toast[];
  paused: boolean;
  dismiss: (id: number) => void;
  container?: HTMLElement | null;
}) {
  const toast = toasts[0];
  const change = toast && isChangeNotice(toast.notice) ? toast.notice : undefined;
  const { title, detail } = toast ? describeNotice(toast.notice) : { title: '' };
  useEffect(() => {
    if (paused || !toast || !isChangeNotice(toast.notice)) return;
    const timer = setTimeout(() => dismiss(toast.id), 1800);
    return () => clearTimeout(timer);
  }, [toast, paused, dismiss]);

  if (paused || !toast) return null;
  if (change) {
    const delta =
      change.kind === 'item'
        ? change.delta
        : typeof change.before === 'number' && typeof change.after === 'number'
          ? change.after - change.before
          : 0;
    const Icon = change.kind === 'item' ? Backpack : SlidersHorizontal;
    return (
      <div className="player-change-notice" role="status" aria-atomic="true">
        <div className="player-change-card" key={toast.id} data-direction={Math.sign(delta)}>
          <span className="player-change-icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <div className="player-change-copy">
            <strong>{title}</strong>
            <span>{detail}</span>
          </div>
          {delta > 0 && <ArrowUp size={17} aria-hidden="true" />}
          {delta < 0 && <ArrowDown size={17} aria-hidden="true" />}
        </div>
      </div>
    );
  }
  return (
    <Dialog.Root open>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="player-notice-overlay" />
        <Dialog.Content
          role="alertdialog"
          aria-describedby={detail ? 'player-notice-detail' : undefined}
          className="player-toast"
          data-kind={toast.notice.kind}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            // A choice may have unmounted while entering the next scene.
            if (toasts.length === 1) {
              event.preventDefault();
              container?.querySelector<HTMLElement>('[aria-label="游戏画面"]')?.focus();
            }
          }}
        >
          <div className="player-toast-copy" key={toast.id} aria-live="polite" aria-atomic="true">
            <Dialog.Title className="player-notice-title">{title}</Dialog.Title>
            {detail && <Dialog.Description id="player-notice-detail">{detail}</Dialog.Description>}
          </div>
          <Button
            variant="primary"
            className="player-notice-confirm"
            onKeyDown={(event) => {
              if (event.repeat) event.preventDefault();
            }}
            onClick={() => dismiss(toast.id)}
          >
            确认
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
