import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project, Scene } from '../../../packages/domain/schema';
import {
  activeStoryboard,
  audioSourceMs,
  audioVolumeAt,
  stillAt,
  stillClipsFor,
  storyboardOverlayPages,
  videoAt,
} from '../../../packages/domain/timeline';
import { assetUrl } from '../../platform';
import { Storyboard } from './Storyboard';

type VideoCue = NonNullable<ReturnType<typeof videoAt>>;
const mediaKey = (cue: VideoCue) => cue.clip.id + ':' + cue.clip.assetId;
const videoPreloadMs = 6000;
const audioPreloadMs = 1800;

/** Keep the last decoded frame visible until the incoming clip can replace it. */
export function TimelineMedia({
  project,
  scene,
  positionMs,
  playing,
  playbackRate = 1,
  muted = false,
  resolveAsset = assetUrl,
  onPosition,
  onError,
  onBlocked,
}: {
  project: Project;
  scene: Scene;
  positionMs: number;
  playing: boolean;
  playbackRate?: number;
  muted?: boolean;
  resolveAsset?: typeof assetUrl;
  onPosition: (ms: number) => void;
  onError: () => void;
  onBlocked: () => void;
}) {
  const assets = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets]);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const pending = useRef(new WeakSet<HTMLMediaElement>());
  const audioCorrections = useRef(new WeakMap<HTMLAudioElement, number>());
  const waiting = useRef<HTMLVideoElement | null>(null);
  const completed = useRef<HTMLVideoElement | null>(null);
  const clock = useRef<{ video: HTMLVideoElement; position: number; target: number } | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const [shown, setShown] = useState<VideoCue>();
  const active = videoAt(scene, positionMs);
  const still = stillAt(stillClipsFor(project, scene), positionMs);
  const storyboard = activeStoryboard(scene);
  const overlay = storyboardOverlayPages(project, scene);
  const activeKey = active && mediaKey(active);
  const holding = !!active && shown && mediaKey(shown) !== activeKey;
  const next =
    playing && visible && active && active.endMs - positionMs <= videoPreloadMs * playbackRate
      ? videoAt(scene, active.endMs)
      : undefined;
  const standby = holding ? shown : next && mediaKey(next) !== activeKey ? next : undefined;
  const cues =
    standby && active && standby.startMs < active.startMs ? [standby, active] : [active, standby];
  const audioClips = (scene.timeline?.audioClips ?? []).filter(
    (clip) =>
      clip.startMs <= positionMs + audioPreloadMs * playbackRate &&
      positionMs < clip.startMs + clip.durationMs,
  );
  const snapshot = {
    active,
    activeKey,
    audioClips,
    playing: playing && visible,
    playbackRate,
    positionMs,
    onPosition,
    onError,
    onBlocked,
  };
  const latest = useRef(snapshot);
  latest.current = snapshot;

  const bindVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element) return;
    const key = element.dataset.mediaKey!;
    videos.current.set(key, element);
    return () => {
      element.pause();
      if (waiting.current === element) waiting.current = null;
      if (completed.current === element) completed.current = null;
      videos.current.delete(key);
    };
  }, []);
  const bindAudio = useCallback((element: HTMLAudioElement | null) => {
    if (!element) return;
    const id = element.dataset.audioId!;
    audios.current.set(id, element);
    return () => {
      element.pause();
      audios.current.delete(id);
    };
  }, []);

  const play = (element: HTMLMediaElement) => {
    if (!element.paused || pending.current.has(element)) return;
    pending.current.add(element);
    void element
      .play()
      .catch((error: unknown) => {
        const current = latest.current;
        if (
          element.isConnected &&
          current.playing &&
          !document.hidden &&
          (element.tagName !== 'VIDEO' || current.activeKey === element.dataset.mediaKey) &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          current.onBlocked();
      })
      .finally(() => pending.current.delete(element));
  };
  const pauseAudio = () => audios.current.forEach((element) => element.pause());
  const videoPosition = (cue: VideoCue, element: HTMLVideoElement) =>
    Math.min(
      cue.endMs,
      cue.startMs + Math.max(0, element.currentTime * 1000 - cue.clip.trimStartMs),
    );
  const syncAudio = () => {
    const current = latest.current;
    const video = current.activeKey && videos.current.get(current.activeKey);
    if (
      !current.playing ||
      document.hidden ||
      (current.active &&
        (!video ||
          video.paused ||
          video.seeking ||
          video.readyState < 2 ||
          waiting.current === video))
    ) {
      pauseAudio();
      return;
    }
    const position =
      video && current.active ? videoPosition(current.active, video) : current.positionMs;
    const now = performance.now();
    for (const clip of current.audioClips) {
      const element = audios.current.get(clip.id);
      if (!element) continue;
      const source = audioSourceMs(clip, position);
      if (source === undefined || element.readyState < 1) {
        element.pause();
        continue;
      }
      element.volume = audioVolumeAt(clip, position);
      if (element.playbackRate !== current.playbackRate)
        element.playbackRate = current.playbackRate;
      if (element.seeking) continue;
      const offset = Math.abs(element.currentTime * 1000 - source);
      const drift = element.loop
        ? Math.min(offset, Math.abs(clip.trimEndMs - clip.trimStartMs - offset))
        : offset;
      const lastCorrection = audioCorrections.current.get(element) ?? -Infinity;
      if ((element.paused && drift > 90) || (drift > 320 && now - lastCorrection >= 750)) {
        audioCorrections.current.set(element, now);
        element.currentTime = source / 1000;
      }
      play(element);
    }
  };
  const syncVideo = () => {
    const current = latest.current;
    const cue = current.active;
    const element = current.activeKey && videos.current.get(current.activeKey);
    if (!cue || !element) return;
    if (element.error) {
      current.onError();
      return;
    }
    if (element.readyState < 1) return;
    if (element.playbackRate !== current.playbackRate) element.playbackRate = current.playbackRate;
    const target = cue.sourceMs / 1000;
    const previous = clock.current;
    const discontinuity =
      previous?.video !== element ||
      (!current.playing && previous.target !== target) ||
      Math.abs(previous.position - current.positionMs) > 300 * current.playbackRate;
    clock.current = { video: element, position: current.positionMs, target };
    const tolerance =
      previous?.video === element && current.playing ? 0.2 * current.playbackRate : 0.012;
    if (discontinuity && Math.abs(element.currentTime - target) > tolerance) {
      if (completed.current === element) completed.current = null;
      element.currentTime = target;
    }
    element.volume = cue.clip.volume;
    if (element.readyState >= 2 && !element.seeking)
      setShown((prior) => (prior && mediaKey(prior) === current.activeKey ? prior : cue));
    if (current.playing && completed.current !== element && !document.hidden) play(element);
    else element.pause();
  };

  useLayoutEffect(() => {
    for (const [key, element] of videos.current) {
      if (key !== activeKey) element.pause();
    }
    syncVideo();
    syncAudio();
  });
  useEffect(() => {
    const change = () => {
      setVisible(!document.hidden);
      if (document.hidden) {
        videos.current.forEach((element) => element.pause());
        pauseAudio();
      }
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 40) {
        last = now;
        const current = latest.current;
        const element = current.activeKey && videos.current.get(current.activeKey);
        if (
          current.playing &&
          current.active &&
          element &&
          !element.paused &&
          !element.seeking &&
          element.readyState >= 2 &&
          waiting.current !== element
        ) {
          const position = videoPosition(current.active, element);
          if (position >= current.active.endMs) {
            completed.current = element;
            element.pause();
            pauseAudio();
          } else syncAudio();
          current.onPosition(position);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  const suspendAudio = (element: HTMLVideoElement) => {
    if (element.dataset.mediaKey === latest.current.activeKey) {
      waiting.current = element;
      pauseAudio();
    }
  };

  return (
    <div className="timeline-media">
      {active && assets.has(active.clip.assetId) ? (
        cues.map((cue) => {
          if (!cue) return null;
          const asset = assets.get(cue.clip.assetId);
          if (!asset) return null;
          const key = mediaKey(cue);
          return (
            <video
              key={key}
              ref={bindVideo}
              data-media-key={key}
              hidden={holding ? key !== mediaKey(shown) : key !== activeKey}
              src={resolveAsset(asset)}
              poster={!shown && key === activeKey ? resolveAsset(asset, true) : undefined}
              playsInline
              muted={muted}
              preload="auto"
              onLoadedMetadata={(event) => {
                if (key === latest.current.activeKey) syncVideo();
                else if (cue.clip.trimStartMs > 0)
                  event.currentTarget.currentTime = cue.clip.trimStartMs / 1000;
              }}
              onLoadedData={syncVideo}
              onCanPlay={syncVideo}
              onPlaying={(event) => {
                if (waiting.current === event.currentTarget) waiting.current = null;
                syncAudio();
              }}
              onSeeked={(event) => {
                if (waiting.current === event.currentTarget && event.currentTarget.readyState >= 3)
                  waiting.current = null;
                syncVideo();
                syncAudio();
              }}
              onWaiting={(event) => suspendAudio(event.currentTarget)}
              onSeeking={(event) => suspendAudio(event.currentTarget)}
              onEnded={(event) => {
                const current = latest.current;
                if (key === current.activeKey && current.playing && current.active) {
                  completed.current = event.currentTarget;
                  pauseAudio();
                  current.onPosition(current.active.endMs);
                }
              }}
              onError={() => {
                if (key === latest.current.activeKey) latest.current.onError();
              }}
            />
          );
        })
      ) : still ? (
        [
          still.previous,
          still.clip,
          still.endMs - positionMs <= 2500 * playbackRate ? still.next : undefined,
        ].map((clip) => {
          if (!clip) return null;
          const asset = assets.get(clip.assetId);
          if (!asset) return null;
          const active = clip === still.clip;
          return (
            <img
              key={clip.id + ':' + clip.assetId}
              className="timeline-still"
              data-active={active || undefined}
              hidden={clip === still.next}
              style={active && still.previous ? { opacity: still.mix } : undefined}
              src={resolveAsset(asset)}
              alt=""
              onError={active ? onError : undefined}
            />
          );
        })
      ) : storyboard ? (
        <Storyboard pages={storyboard} positionMs={positionMs} />
      ) : (
        <div className="timeline-no-video">未绑定画面素材</div>
      )}
      {overlay && <Storyboard pages={overlay} positionMs={positionMs} overlay />}
      {audioClips.map((clip) => {
        const asset = assets.get(clip.assetId);
        if (!asset) return null;
        return (
          <audio
            key={clip.id + ':' + asset.id}
            ref={bindAudio}
            data-audio-id={clip.id}
            src={resolveAsset(asset)}
            muted={muted}
            loop={clip.loop && clip.trimStartMs === 0 && clip.trimEndMs === asset.durationMs}
            preload="auto"
            onLoadedMetadata={syncAudio}
            onCanPlay={syncAudio}
            onSeeked={syncAudio}
            onError={() => {
              if (audioSourceMs(clip, latest.current.positionMs) !== undefined)
                latest.current.onError();
            }}
          />
        );
      })}
    </div>
  );
}
