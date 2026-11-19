import { parseProject, type Project } from '../../../packages/domain/schema';
import { validateProject } from '../../../packages/domain/validation';
import type { ViewIntent } from '../../../packages/agent/types';
import { useEditor } from '../../store/editor';

export function commitAgentTransaction(
  base: Project,
  candidate: Project,
  intents: ViewIntent[],
  expectedSerial: number,
  options?: { versionTitle?: string; historicalDraft?: boolean; undoGroup?: string },
): boolean {
  const state = useEditor.getState();
  // Check both the expected snapshot and the editor's in-memory change sequence.
  if (
    state.project !== base ||
    state.changeSerial !== expectedSerial ||
    state.playing ||
    candidate.id !== base.id
  )
    return false;
  const parsed = parseProject(candidate);
  if (!options?.historicalDraft) {
    const key = (i: ReturnType<typeof validateProject>[number]) => i.nodeId + ':' + i.message;
    const baseline = new Set(
      validateProject(base)
        .filter((i) => i.severity === 'error')
        .map(key),
    );
    if (validateProject(parsed).some((i) => i.severity === 'error' && !baseline.has(key(i))))
      return false;
  }
  if (JSON.stringify(parsed) !== JSON.stringify(base))
    state.commit(
      (p) => {
        for (const key of Object.keys(p)) {
          if (!Object.hasOwn(parsed, key)) Reflect.deleteProperty(p, key);
        }
        Object.assign(p, parsed);
      },
      options?.undoGroup,
      options?.versionTitle,
      Boolean(options?.undoGroup),
    );
  for (const intent of intents) {
    if (intent.kind === 'focus') useEditor.getState().focusScene(intent.nodeId);
    else if (intent.kind === 'diagnostics') useEditor.setState({ diagnosticsOpen: true });
    else if (
      intent.kind === 'preview' &&
      useEditor.getState().project.scenes.some((s) => s.id === intent.nodeId)
    )
      useEditor.setState({ playing: true, playFrom: intent.nodeId });
  }
  return true;
}
