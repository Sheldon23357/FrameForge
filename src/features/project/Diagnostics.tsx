import { CheckCircle, WarningCircle, XCircle, ArrowUpRight, X } from '@phosphor-icons/react';
import { validateProject } from '../../../packages/domain/validation';
import { useEditor } from '../../store/editor';
import { IconButton } from '../../components/ui';
export function Diagnostics() {
  const p = useEditor((s) => s.project);
  const issues = validateProject(p);
  return (
    <section className="diagnostics-panel">
      <div className="diagnostics-heading">
        <h3>
          工程检查<span>{issues.length}</span>
        </h3>
        <IconButton
          label="关闭工程检查"
          onClick={() => useEditor.setState({ diagnosticsOpen: false })}
        >
          <X size={16} />
        </IconButton>
      </div>
      <div className="diagnostics-body">
        {issues.length ? (
          issues.map((d, i) => (
            <button
              key={i}
              className={`diagnostic ${d.severity}`}
              onClick={() => {
                if (d.nodeId) useEditor.getState().focusScene(d.nodeId);
              }}
            >
              {d.severity === 'error' ? <XCircle size={17} /> : <WarningCircle size={17} />}
              <span>
                {d.nodeId && <strong>{p.scenes.find((s) => s.id === d.nodeId)?.title}</strong>}
                {d.message}
              </span>
              {d.nodeId && <ArrowUpRight size={14} />}
            </button>
          ))
        ) : (
          <div className="diagnostics-success">
            <CheckCircle size={22} weight="duotone" />
            <div>
              <strong>工程检查通过</strong>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
