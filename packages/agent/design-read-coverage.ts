import type { DesignTarget } from '../domain/story-design';

type Row = Record<string, unknown>;

export interface DesignPage {
  key: string;
  offset: number;
  total: number;
  text: string;
  versioned: boolean;
}

export function designPage(query: Row, data: Row): DesignPage | undefined {
  if (typeof data.text !== 'string' || typeof data.total !== 'number') return;
  const target = (data.target ?? query.target) as DesignTarget;
  return {
    key: JSON.stringify([
      target?.stage,
      target?.chapterId,
      data.sceneKey ?? query.sceneKey,
      data.source ?? query.source ?? 'project',
      data.version,
      data.status,
      data.total,
    ]),
    offset: Number(data.offset ?? query.offset ?? 0),
    total: data.total,
    text: data.text,
    versioned: typeof data.version === 'string',
  };
}

export function missingDesignRanges(page: DesignPage, pages: readonly DesignPage[]) {
  const end = page.offset + page.text.length;
  const matching = pages
    .filter((previous) => previous.key === page.key)
    .map((previous) => ({
      previous,
      start: Math.max(page.offset, previous.offset),
      end: Math.min(end, previous.offset + previous.text.length),
    }))
    .filter(
      ({ previous, start, end }) =>
        start < end &&
        (page.versioned ||
          page.text.slice(start - page.offset, end - page.offset) ===
            previous.text.slice(start - previous.offset, end - previous.offset)),
    )
    .sort((a, b) => a.start - b.start);
  const missing: { start: number; end: number }[] = [];
  let cursor = page.offset;
  for (const range of matching) {
    if (range.start > cursor) missing.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) missing.push({ start: cursor, end });
  return missing;
}

export function coversDesign(page: DesignPage, pages: readonly DesignPage[]) {
  return page.text.length
    ? missingDesignRanges(page, pages).length === 0
    : pages.some(
        (previous) =>
          previous.key === page.key &&
          (previous.offset === page.offset || (page.versioned && page.offset >= page.total)),
      );
}

export function nextDesignOffset(page: DesignPage, start: number, pages: readonly DesignPage[]) {
  if (start >= page.total) return null;
  if (!page.versioned) return start;
  let cursor = start;
  for (const previous of pages
    .filter(({ key }) => key === page.key)
    .sort((a, b) => a.offset - b.offset)) {
    if (previous.offset > cursor) break;
    cursor = Math.max(cursor, previous.offset + previous.text.length);
  }
  return cursor >= page.total ? null : cursor;
}
