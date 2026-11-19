import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play, WarningCircle } from '@phosphor-icons/react';
import type { Asset } from '../../../packages/domain/schema';
import { IconButton, time } from '../../components/ui';
import { assetUrl } from '../../platform';

export function AssetAudioBar({
  asset,
  onAudition,
}: {
  asset: Asset;
  onAudition: (audio: HTMLAudioElement) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const src = assetUrl(asset);
  const elapsed = Math.min(position, duration);
  const totalMs = duration ? duration * 1000 : asset.durationMs;
  const progress = duration ? (elapsed / duration) * 100 : 0;

  useEffect(() => {
    const media = audio.current!;
    return () => {
      media.pause();
      if (media.hasAttribute('src')) {
        media.removeAttribute('src');
        media.load();
      }
    };
  }, []);

  const toggle = async () => {
    const media = audio.current!;
    if (!media.paused) {
      media.pause();
      return;
    }
    if (!src) {
      setFailed(true);
      return;
    }
    if (!media.hasAttribute('src') || media.error) {
      media.src = src;
      setDuration(0);
      setPosition(0);
    }
    setFailed(false);
    onAudition(media);
    try {
      await media.play();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
    }
  };

  return (
    <div
      className="asset-audio-bar"
      data-playing={playing}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <IconButton
        label={`${playing ? '暂停' : '试听'} ${asset.name}`}
        className="asset-audio-toggle"
        onClick={() => void toggle()}
      >
        {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
      </IconButton>
      <div className="asset-audio-body">
        <div className="asset-audio-heading">
          <strong className="asset-audio-name">{asset.name}</strong>
          <span className="asset-audio-duration">{totalMs ? time(totalMs) : '–:–'}</span>
        </div>
        {failed ? (
          <span className="asset-audio-error" role="status">
            <WarningCircle size={12} /> 无法播放
          </span>
        ) : (
          <div className="asset-audio-transport">
            <span className="asset-audio-elapsed" aria-hidden="true">
              {time(elapsed * 1000)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.01}
              value={elapsed}
              style={{ '--audio-progress': `${progress}%` } as CSSProperties}
              disabled={!duration}
              aria-label={`试听进度 ${asset.name}`}
              aria-valuetext={time(elapsed * 1000)}
              onChange={(event) => {
                const seconds = Number(event.currentTarget.value);
                audio.current!.currentTime = seconds;
                setPosition(seconds);
              }}
            />
          </div>
        )}
      </div>
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onDurationChange={({ currentTarget }) =>
          setDuration(Number.isFinite(currentTarget.duration) ? currentTarget.duration : 0)
        }
        onTimeUpdate={({ currentTarget }) => setPosition(currentTarget.currentTime)}
        onError={() => {
          setPlaying(false);
          setFailed(true);
        }}
      />
    </div>
  );
}
