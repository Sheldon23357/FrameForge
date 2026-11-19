import { useState } from 'react';
import {
  Project,
  Scene,
  defaultStoryboardPageDurationMs,
  storyboardPagesSchema,
} from '../../../packages/domain/schema';

import { FilmStrip, Play, ArrowRight, GitBranch } from '@phosphor-icons/react';
import { Button, Field, Section, time } from '../../components/ui';
import { StoryboardPageFields } from '../../components/StoryboardPageFields';
import { assetUrl } from '../../platform';
import { useEditor } from '../../store/editor';
import { SceneOptions, CrossChapterTarget } from './SceneTarget';
import { openNodeTimeline } from '../timeline/TimelineEditor';
import {
  activeStoryboard,
  nodeDuration,
  playerTextLabels,
  playerTextPlayback,
} from '../../../packages/domain/timeline';

export function SceneProperties({
  project: p,
  scene: s,
  change,
  onShowChoices,
}: {
  project: Project;
  scene: Scene;
  change: (patch: Partial<Scene>) => void;
  onShowChoices: () => void;
}) {
  const [newPage, setNewPage] = useState<string>();
  const asset = p.assets.find((a) => a.id === s.assetId);
  const storyboard = activeStoryboard(s);
  const storyboardPages = s.storyboardPages ?? [];
  const playerText = playerTextPlayback(p, s);
  return (
    <>
      {s.kind !== 'branch' && (
        <Section
          title={
            s.kind === 'ending'
              ? '结局画面'
              : storyboard
                ? '剧情文字'
                : asset?.type === 'image'
                  ? '静态画面'
                  : '视频素材'
          }
        >
          <div className="inspector-preview">
            {asset ? (
              <img src={assetUrl(asset, true)} alt={asset.name} />
            ) : (
              <FilmStrip size={30} weight="thin" />
            )}
            <button
              aria-label="从此节点试玩"
              onClick={() => useEditor.setState({ playing: true, playFrom: s.id })}
            >
              <Play size={18} weight="fill" />
            </button>
            {(asset || storyboard) && (
              <span>
                {time(
                  s.timeline || storyboard ? nodeDuration(p, s) : asset?.durationMs || s.durationMs,
                )}
              </span>
            )}
          </div>
          {s.kind === 'video' && (
            <Button className="full-width" onClick={() => openNodeTimeline(s.id)}>
              <FilmStrip size={15} />
              编辑节点时间线
            </Button>
          )}
          {s.timeline && (
            <p className="inline-note">
              {storyboard
                ? `${storyboard.length} 页剧情文字`
                : s.timeline.stillClips?.length
                  ? `${s.timeline.stillClips.length} 张图片`
                  : s.timeline.stillAssetId
                    ? '静态画面'
                    : `${s.timeline.videoClips.length} 段视频`}{' '}
              · {s.timeline.audioClips.length} 条音频 · {time(nodeDuration(p, s))}
              。在时间线中编辑素材与裁剪。
            </p>
          )}
          {s.kind === 'video' && (
            <details className="inspector-storyboard">
              <summary>剧情文字 · {playerTextLabels[playerText.mode]}</summary>
              {playerText.compressed && (
                <p className="inline-note">
                  叠字由 {playerText.authoredDurationMs / 1000} 秒缩短至{' '}
                  {playerText.effectiveDurationMs / 1000} 秒。
                </p>
              )}
              {playerText.choiceBeforeTextEnd && (
                <p className="inline-note">选项会在最后一页剧情文字结束前出现。</p>
              )}
              {!!storyboardPages.length && (
                <label className="timeline-storyboard-toggle">
                  <input
                    type="checkbox"
                    checked={s.storyboardOverlay ?? false}
                    onChange={(event) =>
                      change({ storyboardOverlay: event.target.checked || undefined })
                    }
                  />
                  在素材上显示剧情文字
                </label>
              )}
              <ol className="storyboard-page-list">
                {storyboardPages.map((_, index) => (
                  <li key={index}>
                    <StoryboardPageFields
                      pages={storyboardPages}
                      index={index}
                      showDuration={false}
                      onChange={(pages) => change({ storyboardPages: pages })}
                    />
                    <Button
                      variant="ghost"
                      aria-label={'删除剧情文字第 ' + (index + 1) + ' 页'}
                      onClick={() =>
                        change({ storyboardPages: storyboardPages.filter((_, i) => i !== index) })
                      }
                    >
                      删除本页
                    </Button>
                  </li>
                ))}
              </ol>
              {newPage === undefined ? (
                <Button
                  variant="ghost"
                  disabled={storyboardPages.length >= 20}
                  onClick={() => setNewPage('')}
                >
                  添加剧情文字页
                </Button>
              ) : (
                <>
                  <Field label="新页正文">
                    <textarea
                      rows={3}
                      maxLength={160}
                      value={newPage}
                      onChange={(event) => setNewPage(event.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={!newPage.trim() || storyboardPages.length >= 20}
                    onClick={() => {
                      change({
                        storyboardPages: storyboardPagesSchema.parse([
                          ...storyboardPages,
                          { text: newPage, durationMs: defaultStoryboardPageDurationMs },
                        ]),
                      });
                      setNewPage(undefined);
                    }}
                  >
                    保存新页
                  </Button>
                  <Button variant="ghost" onClick={() => setNewPage(undefined)}>
                    取消
                  </Button>
                </>
              )}
            </details>
          )}
        </Section>
      )}
      {s.kind === 'ending' ? (
        <Section title="结局信息">
          <Field label="结局标题">
            <input
              value={s.endingLabel}
              onChange={(e) => change({ endingLabel: e.target.value })}
            />
          </Field>
          <Field label="结局总结">
            <textarea
              rows={4}
              value={s.endingText}
              onChange={(e) => change({ endingText: e.target.value })}
            />
          </Field>
        </Section>
      ) : (
        <Section title="播放与跳转">
          {s.kind === 'video' && s.choices.length === 0 && (
            <>
              <Field label="自动跳转">
                <select
                  disabled={s.choices.length > 0}
                  value={s.nextId}
                  onChange={(e) => change({ nextId: e.target.value })}
                >
                  <option value="">停留在此节点</option>
                  <SceneOptions project={p} />
                </select>
              </Field>
              <CrossChapterTarget project={p} scene={s} targetId={s.nextId} />
            </>
          )}
          <Button className="full-width" variant="ghost" onClick={() => onShowChoices()}>
            <GitBranch size={15} />
            配置{s.kind === 'branch' ? '判定分支' : '选择与跳转'}
            <span className="count-badge">{s.choices.length}</span>
            <ArrowRight size={13} />
          </Button>
        </Section>
      )}
    </>
  );
}
