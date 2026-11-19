/** Additive text migration: v1 descriptions become private notes or ending copy. */
export function migrateProject(input: unknown): unknown {
  return migrateChapterStart(migrateChapters(migrateText(input)));
}

function migrateText(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const project = input as Record<string, unknown>;
  if (project.formatVersion !== 1 || !Array.isArray(project.scenes)) return input;
  return {
    ...project,
    formatVersion: 2,
    scenes: project.scenes.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const scene = value as Record<string, unknown>;
      return {
        ...scene,
        notes: Object.hasOwn(scene, 'notes')
          ? scene.notes
          : scene.kind === 'ending'
            ? ''
            : (scene.description ?? ''),
        endingText: Object.hasOwn(scene, 'endingText')
          ? scene.endingText
          : scene.kind === 'ending'
            ? (scene.description ?? '')
            : '',
      };
    }),
  };
}

/** v2 → v3: preserve the first-seen chapter order and every node/link/layout ID. */
function migrateChapters(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const project = input as Record<string, unknown>;
  if (project.formatVersion !== 2 || !Array.isArray(project.scenes)) return input;
  const chapters: { id: string; title: string; startNodeId: string }[] = [];
  const byName = new Map<string, (typeof chapters)[number]>();
  const used = new Set<string>();
  const collect = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if ('id' in v && typeof v.id === 'string') used.add(v.id);
    Object.values(v).forEach(collect);
  };
  collect(project);
  const scenes = project.scenes.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { chapter = '第一章', ...scene } = value as Record<string, unknown>;
    // Leave malformed legacy data for schema validation to reject.
    if (typeof chapter !== 'string') throw new Error('旧工程的章节名称无效。');
    let entry = byName.get(chapter);
    if (!entry) {
      let id = `chapter_legacy_${chapters.length + 1}`;
      while (used.has(id)) id += '_';
      used.add(id);
      const base = chapter.trim() || '未分章';
      let title = base;
      let suffix = 2;
      while (chapters.some((c) => c.title === title)) title = `${base} (${suffix++})`;
      entry = { id, title, startNodeId: typeof scene.id === 'string' ? scene.id : '' };
      chapters.push(entry);
      byName.set(chapter, entry);
    }
    if (scene.id === project.startNodeId) entry.startNodeId = scene.id as string;
    return { ...scene, chapterId: entry.id };
  });
  if (!chapters.length) chapters.push({ id: 'chapter_default', title: '第一章', startNodeId: '' });
  return { ...project, formatVersion: 3, chapters, scenes };
}

/** v3 → v4: keep the existing opening scene by placing its chapter first. */
function migrateChapterStart(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const project = input as Record<string, unknown>;
  if (
    project.formatVersion !== 3 ||
    !Array.isArray(project.chapters) ||
    !Array.isArray(project.scenes)
  )
    return input;
  const scene = project.scenes.find(
    (value) => value && typeof value === 'object' && value.id === project.startNodeId,
  );
  const index = scene
    ? project.chapters.findIndex(
        (chapter) => chapter && typeof chapter === 'object' && chapter.id === scene.chapterId,
      )
    : -1;
  const chapters = [...project.chapters];
  if (index >= 0) {
    const [opening] = chapters.splice(index, 1);
    chapters.unshift({ ...opening, startNodeId: scene.id });
  }
  return { ...project, formatVersion: 4, chapters };
}
