import { Project, Scene, Choice } from '../../../packages/domain/schema';
import { choiceQuestionMaxLength, makeChoice } from '../../../packages/domain/schema';
import { nodeDuration } from '../../../packages/domain/timeline';
import { GitBranch, Plus, ArrowUp, ArrowDown, PencilSimple, Trash } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { Button, Empty, Field, IconButton, Section, Toggle } from '../../components/ui';
import { StoryTimeInput } from '../../components/StoryTimeInput';

import { ConditionEditor } from '../rules/ConditionEditor';
import { CrossChapterTarget } from './SceneTarget';

function ChoiceTitle({ label, onChange }: { label: string; onChange: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  return (
    <span className="choice-title">
      {editing ? (
        <input
          aria-label="选项文案"
          autoFocus
          value={label}
          maxLength={500}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            editButton.current?.focus();
          }}
        />
      ) : (
        <strong title={label}>{label || '未命名选项'}</strong>
      )}
      <IconButton
        label="编辑选项文案"
        ref={editButton}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }}
      >
        <PencilSimple size={13} />
      </IconButton>
    </span>
  );
}

export function ChoicesPanel({
  project: p,
  scene: s,
  change,
}: {
  project: Project;
  scene: Scene;
  change: (patch: Partial<Scene>) => void;
}) {
  const updateChoice = (id: string, v: Partial<Choice>) =>
    change({ choices: s.choices.map((c) => (c.id === id ? { ...c, ...v } : c)) });
  return (
    <>
      <Section
        title={s.kind === 'branch' ? '分支出口' : '互动选项'}
        action={
          <IconButton
            label="添加选项"
            onClick={() =>
              change({
                choices: [...s.choices, makeChoice(s.kind === 'branch' ? '其他情况' : '新的选择')],
              })
            }
          >
            <Plus size={16} />
          </IconButton>
        }
      >
        {s.kind === 'video' && (
          <Field
            label="问题（可选）"
            hint={`显示在选项上方，最多 ${choiceQuestionMaxLength} 个字。`}
          >
            <input
              aria-label="问题（可选）"
              maxLength={choiceQuestionMaxLength}
              value={s.choiceQuestion ?? ''}
              onChange={(e) => change({ choiceQuestion: e.target.value || undefined })}
            />
          </Field>
        )}
        {!s.choices.length && <Empty icon={<GitBranch size={24} />}>暂无选项</Empty>}
        {s.choices.map((c, i) => (
          <details className="choice-editor" key={c.id} open={undefined}>
            <summary>
              <span className="choice-letter">{String.fromCharCode(65 + i)}</span>
              <ChoiceTitle label={c.label} onChange={(label) => updateChoice(c.id, { label })} />
              <span className={`link-state ${c.targetId ? 'linked' : ''}`} />
            </summary>
            <div className="choice-editor-body">
              <div className="choice-toolbar">
                <span>选项 {i + 1}</span>
                <IconButton
                  label="上移选项"
                  disabled={i === 0}
                  onClick={() => {
                    const choices = [...s.choices];
                    [choices[i - 1], choices[i]] = [choices[i], choices[i - 1]];
                    change({ choices });
                  }}
                >
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton
                  label="下移选项"
                  disabled={i === s.choices.length - 1}
                  onClick={() => {
                    const choices = [...s.choices];
                    [choices[i + 1], choices[i]] = [choices[i], choices[i + 1]];
                    change({ choices });
                  }}
                >
                  <ArrowDown size={13} />
                </IconButton>
                <IconButton
                  label="删除选项"
                  onClick={() => change({ choices: s.choices.filter((x) => x.id !== c.id) })}
                >
                  <Trash size={13} />
                </IconButton>
              </div>
              <CrossChapterTarget project={p} scene={s} targetId={c.targetId} />
              <div className="rule-label">解锁条件</div>
              <ConditionEditor
                project={p}
                value={c.condition}
                onChange={(condition) => updateChoice(c.id, { condition })}
              />
              <Toggle
                label="未解锁时隐藏"
                checked={c.hiddenWhenLocked}
                onChange={(hiddenWhenLocked) => updateChoice(c.id, { hiddenWhenLocked })}
              />
              {!c.hiddenWhenLocked && (
                <Field label="未解锁提示">
                  <input
                    value={c.lockedText}
                    onChange={(e) => updateChoice(c.id, { lockedText: e.target.value })}
                  />
                </Field>
              )}
            </div>
          </details>
        ))}
        <Button
          className="add-rule full-width"
          variant="ghost"
          onClick={() => change({ choices: [...s.choices, makeChoice()] })}
        >
          <Plus size={14} />
          添加{s.kind === 'branch' ? '分支' : '选项'}
        </Button>
      </Section>
      {s.kind === 'video' && (
        <Section title="交互时机">
          <Field label="选项出现时间">
            <select
              value={s.choicesAtMs === null ? 'end' : 'time'}
              onChange={(e) => change({ choicesAtMs: e.target.value === 'end' ? null : 0 })}
            >
              <option value="end">视频结束时</option>
              <option value="time">指定时间点</option>
            </select>
          </Field>
          {s.choicesAtMs !== null && (
            <StoryTimeInput
              label="片段内时间（秒）"
              value={s.choicesAtMs}
              durationMs={nodeDuration(p, s)}
              onChange={(choicesAtMs) => change({ choicesAtMs })}
            />
          )}
          <Field label="选择期间">
            <select
              value={s.choiceMode}
              onChange={(e) => change({ choiceMode: e.target.value as Scene['choiceMode'] })}
            >
              <option value="pause">暂停视频，等待选择</option>
              <option value="continue">继续播放视频</option>
            </select>
          </Field>
        </Section>
      )}
    </>
  );
}
