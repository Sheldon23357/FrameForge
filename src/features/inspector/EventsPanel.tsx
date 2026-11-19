import { Project, Scene, StoryEvent } from '../../../packages/domain/schema';
import { uid } from '../../../packages/domain/schema';
import { snapStoryTime } from '../../../packages/domain/story-time';
import { nodeDuration } from '../../../packages/domain/timeline';
import { Plus, Trash, Lightning } from '@phosphor-icons/react';
import { Button, Empty, Field, IconButton, Section, Toggle } from '../../components/ui';
import { StoryTimeInput } from '../../components/StoryTimeInput';

import { EffectEditor } from '../rules/EffectEditor';

export function EventsPanel({
  project: p,
  scene: s,
  change,
}: {
  project: Project;
  scene: Scene;
  change: (patch: Partial<Scene>) => void;
}) {
  const durationMs = nodeDuration(p, s);
  const updateEvent = (id: string, v: Partial<StoryEvent>) =>
    change({ events: s.events.map((e) => (e.id === id ? { ...e, ...v } : e)) });
  return (
    <Section
      title="节点事件"
      action={
        <IconButton
          label="添加事件"
          onClick={() =>
            change({
              events: [
                ...s.events,
                {
                  id: uid('event'),
                  name: '新事件',
                  trigger: 'enter',
                  atMs: 0,
                  once: true,
                  effects: [],
                },
              ],
            })
          }
        >
          <Plus size={16} />
        </IconButton>
      }
    >
      {!s.events.length && <Empty icon={<Lightning size={27} weight="thin" />}>暂无事件</Empty>}
      {s.events.map((e) => (
        <details className="choice-editor" key={e.id} open>
          <summary>
            <Lightning size={14} />
            <strong>{e.name}</strong>
            <span className="muted">
              {e.trigger === 'enter'
                ? '进入'
                : e.trigger === 'exit'
                  ? '离开'
                  : e.trigger === 'complete'
                    ? '播放完成'
                    : `${(snapStoryTime(e.atMs, durationMs) / 1000).toFixed(1)}s`}
            </span>
          </summary>
          <div className="choice-editor-body">
            <div className="choice-toolbar">
              <span>{e.once ? '本局仅一次' : '每次进入均可触发'}</span>
              <IconButton
                label="删除事件"
                onClick={() => change({ events: s.events.filter((x) => x.id !== e.id) })}
              >
                <Trash size={13} />
              </IconButton>
            </div>
            <Field label="事件名称">
              <input
                value={e.name}
                onChange={(ev) => updateEvent(e.id, { name: ev.target.value })}
              />
            </Field>
            <Field label="触发时机">
              <select
                value={e.trigger}
                onChange={(ev) => {
                  const trigger = ev.target.value as StoryEvent['trigger'];
                  updateEvent(e.id, {
                    trigger,
                    ...(trigger === 'time' && { atMs: snapStoryTime(e.atMs, durationMs) }),
                  });
                }}
              >
                <option value="enter">进入节点时</option>
                <option value="time">播放到时间点</option>
                <option value="exit">离开节点时</option>
                {s.kind === 'video' && <option value="complete">视频播放完成时</option>}
              </select>
            </Field>
            {e.trigger === 'time' && (
              <StoryTimeInput
                label="片段内时间（秒）"
                value={e.atMs}
                durationMs={durationMs}
                onChange={(atMs) => atMs !== null && updateEvent(e.id, { atMs })}
              />
            )}
            <Toggle
              label="本次游戏仅触发一次"
              checked={e.once}
              onChange={(once) => updateEvent(e.id, { once })}
            />
            <EffectEditor
              project={p}
              value={e.effects}
              onChange={(effects) => updateEvent(e.id, { effects })}
            />
          </div>
        </details>
      ))}
      <Button
        className="full-width add-rule"
        variant="ghost"
        onClick={() =>
          change({
            events: [
              ...s.events,
              {
                id: uid('event'),
                name: '新事件',
                trigger: 'enter',
                atMs: 0,
                once: true,
                effects: [],
              },
            ],
          })
        }
      >
        <Plus size={14} />
        添加事件
      </Button>
    </Section>
  );
}
