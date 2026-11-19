import type { Value } from '../domain/schema';
import type { RuntimeState } from './engine';

export type RuntimeNotice =
  | { kind: 'message'; name: string; text: string }
  | { kind: 'event'; name: string }
  | { kind: 'variable'; name: string; before: Value; after: Value }
  | { kind: 'item'; name: string; delta: number; total: number };

export function isRuntimeNotice(input: unknown): input is RuntimeNotice {
  if (!input || typeof input !== 'object') return false;
  const notice = input as Record<string, unknown>;
  if (typeof notice.name !== 'string') return false;
  if (notice.kind === 'message')
    return (
      notice.name.length <= 100 &&
      typeof notice.text === 'string' &&
      !!notice.text.trim() &&
      notice.text.length <= 2000
    );
  const isValue = (value: unknown) =>
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
  if (notice.kind === 'event') return true;
  if (notice.kind === 'variable') return isValue(notice.before) && isValue(notice.after);
  return (
    notice.kind === 'item' &&
    Number.isInteger(notice.delta) &&
    Number.isInteger(notice.total) &&
    Number(notice.total) >= 0
  );
}

/** Sequence numbers keep new feedback distinct even after the debug log rolls over. */
export function runtimeLogSince(
  before: RuntimeState | null,
  after: RuntimeState,
): RuntimeState['log'] {
  const sequence = before?.logSequence ?? 0;
  return after.log.filter((entry) => (entry.sequence ?? 0) > sequence);
}

export function runtimeNoticesSince(
  before: RuntimeState | null,
  after: RuntimeState,
): RuntimeNotice[] {
  return runtimeLogSince(before, after).flatMap(({ notice }) => (notice ? [notice] : []));
}
