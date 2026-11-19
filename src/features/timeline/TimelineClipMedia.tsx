import { useEffect, useRef, useState } from 'react';
import type { Asset, AudioClip, VideoClip } from '../../../packages/domain/schema';
import { assetUrl } from '../../platform';

const frameCache = new Map<string, string[]>();
const waveformCache = new Map<string, Promise<Float32Array | null>>();
const cacheLimit = 32;
function boundedCache<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

/** Sample the actual trimmed source; fall back to its poster if canvas access fails. */
export function ClipFilmstrip({ asset, clip }: { asset?: Asset; clip: VideoClip }) {
  const url = asset ? assetUrl(asset) : '';
  const key = `${url}:${clip.trimStartMs}:${clip.trimEndMs}`;
  const [frames, setFrames] = useState<{ key: string; urls: string[] }>();
  useEffect(() => {
    if (!url) return;
    const cached = frameCache.get(key);
    if (cached) {
      setFrames({ key, urls: cached });
      return;
    }
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    const waitFor = (event: 'loadedmetadata' | 'seeked') =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          cleanup();
          resolve();
        };
        const fail = () => {
          cleanup();
          reject(new Error('Frame unavailable'));
        };
        const timer = setTimeout(fail, 4000);
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener(event, done);
          video.removeEventListener('error', fail);
        };
        video.addEventListener(event, done);
        video.addEventListener('error', fail);
      });
    const timer = setTimeout(() => {
      void (async () => {
        const loaded = waitFor('loadedmetadata');
        video.src = url;
        await loaded;
        const canvas = document.createElement('canvas');
        canvas.width = 144;
        canvas.height = 81;
        const context = canvas.getContext('2d');
        if (!context) return;
        const urls: string[] = [];
        for (let i = 0; i < 8; i++) {
          if (cancelled) return;
          const position = Math.max(
            0.001,
            (clip.trimStartMs + ((clip.trimEndMs - clip.trimStartMs) * (i + 0.5)) / 8) / 1000,
          );
          const seeked = waitFor('seeked');
          video.currentTime = Math.min(Math.max(0, video.duration - 0.01), position);
          await seeked;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          urls.push(canvas.toDataURL('image/jpeg', 0.65));
        }
        if (!cancelled) {
          boundedCache(frameCache, key, urls);
          setFrames({ key, urls });
        }
      })()
        .catch(() => {
          /* A poster remains usable for unsupported media. */
        })
        .finally(() => {
          video.removeAttribute('src');
          video.load();
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
    };
  }, [key, url, clip.trimStartMs, clip.trimEndMs]);
  const urls = frames?.key === key ? frames.urls : [];
  return (
    <span
      className="timeline-filmstrip"
      style={
        urls.length
          ? undefined
          : { backgroundImage: asset ? `url("${assetUrl(asset, true)}")` : undefined }
      }
    >
      {urls.map((src, i) => (
        <img key={i} src={src} alt="" draggable={false} />
      ))}
    </span>
  );
}

async function readPeaks(url: string): Promise<Float32Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 30_000_000) return null;
    const context = new OfflineAudioContext(1, 1, 8000);
    const audio = await context.decodeAudioData(buffer);
    const count = Math.min(20000, Math.ceil(audio.duration * 100));
    const peaks = new Float32Array(count);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel);
      for (let i = 0; i < count; i++) {
        const from = Math.floor((i / count) * data.length);
        const to = Math.floor(((i + 1) / count) * data.length);
        for (let j = from; j < to; j += 4) peaks[i] = Math.max(peaks[i], Math.abs(data[j]));
      }
    }
    return peaks;
  } catch {
    return null;
  }
}
/** Real source amplitude, including trim, loop and volume; never synthetic waveform data. */
export function ClipWaveform({
  asset,
  clip,
  visibleMs,
}: {
  asset?: Asset;
  clip: AudioClip;
  visibleMs: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const url = asset ? assetUrl(asset) : '';
  useEffect(() => {
    setPeaks(null);
    if (!url || !asset || asset.durationMs > 600000 || asset.size > 30_000_000) return;
    let cancelled = false;
    let promise = waveformCache.get(url);
    if (!promise) {
      promise = readPeaks(url);
      boundedCache(waveformCache, url, promise);
    }
    void promise.then((value) => {
      if (!cancelled) setPeaks(value);
    });
    return () => {
      cancelled = true;
    };
  }, [url, asset?.id, asset?.durationMs, asset?.size]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !asset || !peaks) return;
    const draw = () => {
      const width = Math.min(4000, Math.ceil(element.clientWidth));
      const height = 30;
      element.width = width;
      element.height = height;
      const context = element.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#9fcab6';
      let max = 0;
      for (const peak of peaks) max = Math.max(max, peak);
      const length = clip.trimEndMs - clip.trimStartMs;
      for (let x = 0; x < width; x += 3) {
        const elapsed = (x / width) * visibleMs;
        const source =
          clip.trimStartMs + (clip.loop ? elapsed % length : Math.min(length, elapsed));
        const peak =
          peaks[
            Math.min(peaks.length - 1, Math.floor((source / asset.durationMs) * peaks.length))
          ] || 0;
        const amplitude = Math.max(1, (peak / (max || 1)) * 24 * clip.volume);
        context.fillRect(x, (height - amplitude) / 2, 1, amplitude);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [peaks, asset, clip.trimStartMs, clip.trimEndMs, clip.loop, clip.volume, visibleMs]);
  return (
    <canvas
      ref={canvas}
      className="timeline-waveform"
      aria-label={peaks ? '音频波形' : '音频波形载入中'}
    />
  );
}
