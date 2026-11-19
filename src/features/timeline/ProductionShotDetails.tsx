import type { ProductionShot, Project } from '../../../packages/domain/schema';
import type { productionShotFrames } from '../../../packages/domain/production-shots';
import { assetUrl } from '../../platform';

const directions = [
  ['source', '来源'],
  ['purpose', '镜头目的'],
  ['camera', '机位与运镜'],
  ['startState', '起始画面'],
  ['action', '动作与表演'],
  ['endState', '结束画面'],
  ['audio', '声音设计'],
] as const;

const prompts = [
  ['firstFramePrompt', '画面提示词'],
  ['lastFramePrompt', '尾帧提示词'],
] as const;

const formatDuration = (ms: number) =>
  (ms / 1000).toLocaleString('zh-CN', {
    maximumFractionDigits: 3,
  }) + ' 秒';

export function ProductionShotDetails({
  project,
  shot,
  frames,
  onPreviewFrame,
}: {
  project: Project;
  shot: ProductionShot;
  frames: ReturnType<typeof productionShotFrames>;
  onPreviewFrame: (key: string) => void;
}) {
  const settings = (shot?.settingIds ?? [])
    .map((id) => project.worldSettings?.find((setting) => setting.id === id)?.name)
    .filter(Boolean);
  const video = shot?.videoAssetId
    ? project.assets.find(({ id }) => id === shot.videoAssetId)
    : undefined;
  return (
    <section className="production-shot-details" aria-label="分镜详情" tabIndex={0}>
      <p className="production-shot-summary">
        {shot.label} · {formatDuration(shot.durationMs)}
      </p>
      {frames.length > 0 && (
        <div className="production-shot-frames">
          {frames.map(({ key, frame, asset }) => {
            const label = frame === 'first' ? '首帧' : '尾帧';
            return (
              <figure key={key}>
                <button
                  type="button"
                  aria-label={`预览${label}`}
                  onClick={() => onPreviewFrame(key)}
                >
                  <img src={assetUrl(asset)} alt={label} />
                </button>
                <figcaption>
                  {label} · {asset.name}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      <dl className="production-shot-fields">
        {settings.length > 0 && (
          <div>
            <dt>参考设定</dt>
            <dd>{settings.join('、')}</dd>
          </div>
        )}
        {video && (
          <div>
            <dt>绑定视频</dt>
            <dd>{video.name}</dd>
          </div>
        )}
        {directions.map(([key, label]) =>
          shot[key] ? (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{shot[key]}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {prompts.some(([key]) => shot[key]) && (
        <section className="production-shot-prompts" aria-label="生成提示词">
          {prompts.map(([key, label]) =>
            shot[key] ? (
              <details key={shot.id + key}>
                <summary>{label}</summary>
                <p>{shot[key]}</p>
              </details>
            ) : null,
          )}
        </section>
      )}
      {!frames.length &&
        !video &&
        !settings.length &&
        !directions.some(([key]) => shot[key]) &&
        !prompts.some(([key]) => shot[key]) && (
          <p className="inline-note">这个镜头还没有填写制作内容。</p>
        )}
    </section>
  );
}
