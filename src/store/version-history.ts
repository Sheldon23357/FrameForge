import type { Project } from '../../packages/domain/schema';
import type { ProjectVersion } from '../../packages/domain/project-versions';

const database = 'frameforge-editor-versions';
const table = 'journals';
interface Journal {
  head: string;
  versions: ProjectVersion[];
}
interface HistorySlots {
  draft?: Journal;
  saved?: Journal;
}
let writes = Promise.resolve();

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(table);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function fingerprint(project: Project) {
  const text = JSON.stringify(project, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storageKey(project: Project, filePath?: string) {
  return JSON.stringify([project.id, window.frameforge ? (filePath ?? '') : '']);
}

export async function readVersionHistory(project: Project, filePath?: string) {
  try {
    await writes.catch(() => {});
    const db = await openDatabase();
    try {
      const record: HistorySlots | undefined = await new Promise((resolve, reject) => {
        const request = db.transaction(table).objectStore(table).get(storageKey(project, filePath));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!record) return undefined;
      const head = await fingerprint(project);
      for (const journal of [record.draft, record.saved]) {
        if (
          journal?.head === head &&
          Array.isArray(journal.versions) &&
          journal.versions.length > 0 &&
          journal.versions.length <= 60 &&
          journal.versions.every(
            (entry) =>
              entry &&
              typeof entry.id === 'string' &&
              typeof entry.at === 'string' &&
              typeof entry.title === 'string' &&
              Array.isArray(entry.details) &&
              entry.details.every((detail) => typeof detail === 'string') &&
              Array.isArray(entry.reverse),
          )
        ) {
          return journal.versions;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // An unavailable journal must not prevent opening the project.
  }
  return undefined;
}

export function saveVersionHistory(
  project: Project,
  versions: ProjectVersion[],
  filePath?: string,
  explicit = false,
) {
  const key = storageKey(project, filePath);
  writes = writes
    .catch(() => {})
    .then(async () => {
      const journal = { head: await fingerprint(project), versions };
      const db = await openDatabase();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(table, 'readwrite');
          const store = transaction.objectStore(table);
          const request = store.get(key);
          request.onsuccess = () => {
            const slots: HistorySlots = request.result ?? {};
            const slot = explicit ? 'saved' : 'draft';
            slots[slot] = journal;
            store.put(slots, key);
          };
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    });
  return writes;
}
