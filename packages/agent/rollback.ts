import type { Project } from '../domain/schema';
import { applyProjectChanges } from '../domain/project-versions';
import { checkpointDigest } from './harness';
import type { AgentSession } from './types';

export function rollbackDigest(project: Project) {
  return checkpointDigest({ ...project, revision: 0, updatedAt: '' });
}

export async function completeRollback(
  session: AgentSession,
  project: Project,
  turnId: string,
  updatedAt: string,
): Promise<AgentSession> {
  const index = session.turns.findIndex((turn) => turn.id === turnId);
  const point = session.turns[index]?.rollback;
  if (!point) throw new Error('找不到回退点对应的对话轮次。');
  const next: AgentSession = {
    ...session,
    turns: session.turns.slice(0, index + 1),
    memory: { summary: '', through: 0, updatedAt },
    pinnedSceneIds: point.pinnedSceneIds,
    creativeDraft: point.creativeDraft,
    checkpoint: undefined,
    rollbackJournal: undefined,
    updatedAt,
  };
  if (point.task) {
    const { changes, ...task } = point.task;
    next.checkpoint = {
      ...task,
      baseRevision: project.revision,
      baseDigest: await checkpointDigest(project),
      baseProject: project,
      draft: applyProjectChanges(project, changes),
    };
  }
  return next;
}

export async function recoverRollback(session: AgentSession, project: Project) {
  const journal = session.rollbackJournal;
  if (!journal || session.projectId !== project.id) return session;
  if ((await rollbackDigest(project)) !== journal.targetDigest)
    return { ...session, rollbackJournal: undefined };
  return completeRollback(session, project, journal.turnId, journal.updatedAt);
}
