import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  X,
  Play,
  Pause,
  RotateCcw as ArrowCounterClockwise,
  Save as FloppyDisk,
  Maximize as ArrowsOut,
  Bug,
  Box as Package,
  Lock as LockSimple,
  ArrowRight,
  CircleAlert as WarningCircle,
  Trophy,
  Film as FilmStrip,
  Waypoints as Graph,
  Minimize as ArrowsIn,
  Backpack,
  SlidersHorizontal,
  Info,
  Menu,
  FlaskConical,
} from 'lucide-react';
import { Project, Value, chapterTitle } from '../../../packages/domain/schema';
import {
  advance,
  availableChoices,
  choose,
  getScene,
  loadGame,
  sceneDuration,
  start,
  type RuntimeState,
} from '../../../packages/runtime/engine';
import { assetUrl } from '../../platform';
import { Button, IconButton, Modal, Field } from '../../components/ui';
import { ValueInput } from '../rules/ConditionEditor';

import { SaveRepository, type SaveSlot } from './saves';
import { SaveManager } from './SaveManager';
import { RouteOverview } from './RouteFlow';
import { mergeProgress, readProgress } from './routes';
import { PlayerAudio, type PlayerCue } from './presentation';
import { runtimeLogSince } from '../../../packages/runtime/notifications';
import {
  isChangeNotice,
  PlayerToasts,
  usePlayerToasts,
  type ChangeNotice,
  type PlayerNotice,
} from './PlayerToasts';
import { TimelineMedia } from './TimelineMedia';
import { Storyboard } from './Storyboard';
import {
  activeStoryboard,
  storyboardAt,
  storyboardOverlayPages,
} from '../../../packages/domain/timeline';
const nodeFadeMs = 150;
const chapterFadeMs = 400;
const fastPlaybackRate = 10;

function PlayerControl({ label, children, ...props }: ComponentProps<typeof IconButton>) {
  return (
    <IconButton label={label} {...props}>
      {children}
      <span className="player-action-label">{label}</span>
    </IconButton>
  );
}
export function Player({
  project: p,
  from,
  onClose,
  standalone = false,
  resolveAsset = assetUrl,
  initialSave,
  offerResume = true,
}: {
  project: Project;
  from?: string;
  onClose?: () => void;
  standalone?: boolean;
  resolveAsset?: typeof assetUrl;
  initialSave?: SaveSlot;
  offerResume?: boolean;
}) {
  const repository = useMemo(
    () => new SaveRepository(localStorage, p, !standalone),
    [p, standalone],
  );
  const resumeCandidate = useMemo(
    () => ({ current: initialSave ?? repository.latest() }),
    [initialSave, repository],
  );
  const [resumePrompt, setResumePrompt] = useState(
    () => !!(offerResume && standalone && !initialSave && resumeCandidate.current),
  );
  const [routeOpen, setRouteOpen] = useState(false);
  const [infoPanel, setInfoPanel] = useState<'attributes' | 'inventory' | 'about' | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [transitionPhase, setTransitionPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const [fadeMs, setFadeMs] = useState(nodeFadeMs);
  const transitionBusy = useRef(false);
  const pendingTransitionState = useRef<RuntimeState | null>(null);
  const transitionAfterNotices = useRef<(() => void) | null>(null);
  const transitionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>();
  const choiceQuestionId = useId();
  const audio = useRef<PlayerAudio | null>(null);
  if (!audio.current) audio.current = new PlayerAudio();
  const playtime = useRef(initialSave?.playtimeMs ?? 0);
  const progressKey = `frameforge.${standalone ? '' : 'preview.'}routes.${p.id}`;
  const [failure, setFailure] = useState('');
  const [state, setState] = useState<RuntimeState | null>(() => {
    try {
      return initialSave ? loadGame(p, initialSave.save) : start(p, from);
    } catch (e) {
      setTimeout(() => setFailure((e as Error).message), 0);
      return null;
    }
  });
  const stateRef = useRef(state);
  const initialVisit = useRef(state?.visitSerial);
  const forceAuto = useRef(false);
  stateRef.current = state;
  const [paused, setPaused] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const playbackRate = ctrlHeld ? fastPlaybackRate : 1;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const [menuOpen, setMenuOpen] = useState(false);
  const [hud, setHud] = useState<'hidden' | 'paused' | 'visible'>('hidden');
  const hudVisible = hud !== 'hidden';
  const playbackPaused = paused || hud === 'paused';
  const toggleHud = useCallback(
    () => setHud((current) => (current === 'hidden' ? 'paused' : 'hidden')),
    [],
  );
  const releaseHudPause = () => setHud((current) => (current === 'paused' ? 'visible' : current));
  const resumePlayback = () => {
    setPaused(false);
    releaseHudPause();
  };
  const togglePlayback = () => {
    if (playbackPaused) resumePlayback();
    else setPaused(true);
  };
  const [portrait, setPortrait] = useState(
    () => window.matchMedia('(orientation: portrait)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(orientation: portrait)');
    const update = () => setPortrait(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  const [fullscreen, setFullscreen] = useState(false);
  const [debug, setDebug] = useState(false);
  const [slotMode, setSlotMode] = useState<'save' | 'load' | null>(null);
  const [restoreKey, setRestoreKey] = useState(0);
  const [mediaError, setMediaError] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testVariables, setTestVariables] = useState<Record<string, Value>>({});
  const [testItems, setTestItems] = useState<Record<string, number>>({});
  const video = useRef<HTMLVideoElement>(null);
  const timelinePosition = useRef<{ visit: number; restore: number; position: number } | null>(
    null,
  );
  const playerRoot = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuEntry = useRef<HTMLButtonElement>(null);
  const hideMenu = () => {
    setMenuOpen(false);
    requestAnimationFrame(() => menuEntry.current?.focus());
  };
  const { toasts, notify, clear: clearToasts, dismiss } = usePlayerToasts();
  const nodeChanges = useRef<ChangeNotice[]>([]);
  const notifyEntry = useCallback(
    (next: RuntimeState) => {
      const notices = runtimeLogSince(null, next).flatMap(({ notice }) =>
        notice && notice.kind !== 'event' ? [notice] : [],
      );
      nodeChanges.current = notices.filter(isChangeNotice);
      notify(notices.filter((notice) => notice.kind === 'message'));
      if (next.phase === 'ended') {
        notify(nodeChanges.current);
        nodeChanges.current = [];
      }
    },
    [notify],
  );
  const setNotice = useCallback(
    (message: string, error = false) => {
      notify([{ kind: error ? 'error' : 'info', message }]);
    },
    [notify],
  );
  const initialNoticesPending = useRef(!initialSave);
  const otherOverlayBlocked =
    !!slotMode || testing || routeOpen || !!infoPanel || resumePrompt || confirmRestart || menuOpen;
  const overlayBlocked = otherOverlayBlocked || toasts.length > 0;
  const n = state ? getScene(p, state) : undefined;
  const storyboard = n && activeStoryboard(n);
  const storyboardOverlay = n && !n.timeline && storyboardOverlayPages(p, n);
  useEffect(() => {
    if (!portrait || menuOpen || overlayBlocked || storyboard) return;
    const frame = requestAnimationFrame(() => menuEntry.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [portrait, menuOpen, overlayBlocked, storyboard]);
  const autosaveAllowed = useRef(!resumePrompt);
  useEffect(() => {
    if (resumePrompt || !stateRef.current || !initialNoticesPending.current) return;
    initialNoticesPending.current = false;
    notifyEntry(stateRef.current);
  }, [resumePrompt, notifyEntry]);
  useEffect(() => {
    if (toasts.length || otherOverlayBlocked) return;
    const begin = transitionAfterNotices.current;
    transitionAfterNotices.current = null;
    begin?.();
  }, [toasts.length, otherOverlayBlocked]);
  autosaveAllowed.current = !resumePrompt && !failure && !mediaError;
  const cue = (kind: PlayerCue) => {
    audio.current?.play(kind, 1);
  };
  const clearTransition = () => {
    pendingTransitionState.current = null;
    transitionAfterNotices.current = null;
    nodeChanges.current = [];
    transitionTimers.current.forEach(clearTimeout);
    transitionTimers.current = [];
    transitionBusy.current = false;
    setTransitionPhase('idle');
    setSelectedChoiceId(undefined);
  };
  const visibleVariables = p.variables.filter((variable) => !variable.hidden);
  const asset = p.assets.find((a) => a.id === n?.assetId);
  const guarded = useCallback(
    (fn: (s: RuntimeState) => RuntimeState) => {
      try {
        const current = stateRef.current;
        if (!current || transitionBusy.current) return;
        const result = fn(current);
        const changedVisit = result.visitSerial !== current.visitSerial;
        const source = getScene(p, current);
        const duration = sceneDuration(p, source);
        const immediate: PlayerNotice[] = [];
        const incoming: ChangeNotice[] = [];
        const entries = runtimeLogSince(current, result);
        // Automatic branch nodes have no frame. Their changes belong to the outgoing shot.
        const destination = changedVisit
          ? entries.reduce((last, entry, index) => (entry.entered ? index : last), -1)
          : -1;
        entries.forEach(({ notice }, index) => {
          if (!notice) return;
          if (isChangeNotice(notice)) {
            const changes =
              destination >= 0 && index > destination ? incoming : nodeChanges.current;
            changes.push(notice);
          } else if (notice.kind === 'message') immediate.push(notice);
        });
        const flushChanges = () => {
          notify(nodeChanges.current);
          nodeChanges.current = [];
        };
        const publish = () => {
          pendingTransitionState.current = null;
          stateRef.current = result;
          setState(result);
          notify(immediate);
          if (changedVisit) nodeChanges.current = incoming;
          if (result.phase === 'ended' || (!changedVisit && result.positionMs >= duration))
            flushChanges();
          setFailure('');
          if (result.phase === 'ended' && current.phase !== 'ended') cue('ending');
        };
        if (changedVisit) {
          pendingTransitionState.current = result;
          transitionBusy.current = true;
          video.current?.pause();
          const target = getScene(p, result);
          const begin = () => {
            const halfFadeMs =
              (source.chapterId === target.chapterId ? nodeFadeMs : chapterFadeMs) /
              playbackRateRef.current;
            setFadeMs(halfFadeMs);
            setTransitionPhase('out');
            transitionTimers.current.push(
              setTimeout(() => {
                publish();
                setTransitionPhase('in');
                transitionTimers.current.push(
                  setTimeout(() => {
                    transitionTimers.current = [];
                    transitionBusy.current = false;
                    setTransitionPhase('idle');
                    setSelectedChoiceId(undefined);
                  }, halfFadeMs),
                );
              }, halfFadeMs),
            );
          };
          if (nodeChanges.current.length) {
            const lastFrame = { ...current, positionMs: duration };
            stateRef.current = lastFrame;
            setState(lastFrame);
            transitionAfterNotices.current = begin;
            flushChanges();
          } else begin();
        } else {
          publish();
          setSelectedChoiceId(undefined);
        }
      } catch (e) {
        setFailure((e as Error).message);
        setPaused(true);
        setNotice((e as Error).message, true);
      }
    },
    [p, notify, setNotice],
  );
  const restart = (at = from) => {
    forceAuto.current = true;
    clearTransition();
    setResumePrompt(false);
    setConfirmRestart(false);
    playtime.current = 0;
    try {
      const result = start(p, at);
      initialNoticesPending.current = false;
      clearToasts();
      notifyEntry(result);
      stateRef.current = result;
      setState(result);
      resumePlayback();
      setFailure('');
      setRestoreKey((k) => k + 1);
    } catch (e) {
      setFailure((e as Error).message);
    }
  };
  const isVideo = asset?.type === 'video' && n?.kind !== 'ending';
  const showingChange = !!toasts[0] && isChangeNotice(toasts[0].notice);
  const reachedEnd = !!state && !!n && state.positionMs >= sceneDuration(p, n);
  useLayoutEffect(() => {
    const element = video.current;
    if (
      !showingChange ||
      !element ||
      !n ||
      element.readyState < 1 ||
      !Number.isFinite(element.duration)
    )
      return;
    const end = (n.trimStartMs + sceneDuration(p, n)) / 1000;
    element.pause();
    // Seeking to the exact end can expose a frame beyond the trim point.
    element.currentTime = Math.max(n.trimStartMs / 1000, Math.min(end, element.duration) - 0.001);
  }, [showingChange, n, p]);
  const isWaiting = state?.phase === 'choosing' && n?.choiceMode === 'pause';
  const mediaCanPlay = useRef(false);
  mediaCanPlay.current =
    !playbackPaused &&
    !overlayBlocked &&
    !transitionBusy.current &&
    transitionPhase === 'idle' &&
    !isWaiting &&
    state?.phase !== 'ended' &&
    !reachedEnd;
  const requestVideoPlay = useCallback((element: HTMLVideoElement) => {
    if (!mediaCanPlay.current || document.hidden) return;
    void element.play().catch((error: unknown) => {
      if (
        video.current === element &&
        mediaCanPlay.current &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        setPaused(true);
    });
  }, []);
  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const update = () => {
      if (element.hidden) return;
      const bottom = Number.parseFloat(getComputedStyle(element).bottom) || 0;
      playerRoot.current?.style.setProperty(
        '--player-hud-offset',
        `${Math.ceil(element.getBoundingClientRect().height + bottom + 14)}px`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [menuOpen]);
  useEffect(() => {
    const changed = () => {
      if (!video.current) return;
      if (document.hidden) video.current.pause();
      else if (mediaCanPlay.current) requestVideoPlay(video.current);
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [requestVideoPlay]);
  useEffect(() => {
    setMediaError(false);
  }, [state?.visitSerial, restoreKey]);
  useLayoutEffect(() => {
    const element = video.current;
    if (!element || !isVideo || !n) return;
    element.playbackRate = playbackRate;
    if (mediaCanPlay.current && !document.hidden) requestVideoPlay(element);
    else {
      element.pause();
      if (isWaiting && !reachedEnd && element.readyState >= 1) {
        const target = (n.trimStartMs + stateRef.current!.positionMs) / 1000;
        if (element.currentTime > target + 0.012) element.currentTime = target;
      }
    }
  }, [
    n,
    playbackRate,
    playbackPaused,
    overlayBlocked,
    transitionPhase,
    isWaiting,
    isVideo,
    state?.visitSerial,
    state?.phase,
    reachedEnd,
    restoreKey,
  ]);
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const slideshowNodes = new Set(
      p.scenes
        .filter((scene) => (scene.timeline?.stillClips?.length ?? 0) > 1)
        .map((scene) => scene.id),
    );
    const tick = (now: number) => {
      const elapsed = now - last;
      const current = stateRef.current;
      if (elapsed >= (current && slideshowNodes.has(current.nodeId) ? 16 : 50)) {
        last = now;
        const s = current;
        if (
          s &&
          !playbackPaused &&
          !overlayBlocked &&
          !transitionBusy.current &&
          !failure &&
          !mediaError &&
          !document.hidden &&
          s.phase !== 'ended'
        ) {
          const scene = getScene(p, s);
          const delta = Math.min(elapsed, 150);
          playtime.current += delta;
          const a = p.assets.find((a) => a.id === scene.assetId);
          const playingVideo = scene.timeline
            ? scene.timeline.videoClips.length > 0
            : a?.type === 'video';
          let position = s.positionMs;
          if (
            s.positionMs < sceneDuration(p, scene) &&
            !(s.phase === 'choosing' && scene.choiceMode === 'pause')
          ) {
            if (scene.timeline && playingVideo) {
              const media = timelinePosition.current;
              if (media?.visit === s.visitSerial && media.restore === restoreKey)
                position = media.position;
            } else if (playingVideo && video.current && video.current.readyState >= 2)
              position = Math.max(0, video.current.currentTime * 1000 - scene.trimStartMs);
            else if (!playingVideo) position += delta * playbackRateRef.current;
          }
          if (position !== s.positionMs) guarded((current) => advance(p, current, position));
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [p, playbackPaused, overlayBlocked, failure, mediaError, guarded, restoreKey]);
  useEffect(() => {
    stageRef.current?.focus();
  }, []);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === playerRoot.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Control' && !e.repeat) setCtrlHeld(true);
      if (overlayBlocked) return;
      if (e.key === 'Tab' && !standalone) {
        const buttons = Array.from(
          playerRoot.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,select,textarea,[tabindex="0"]',
          ) ?? [],
        ).filter((el) => el.offsetParent !== null);
        const first = buttons[0],
          last = buttons.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
      if (e.key === 'Escape') {
        if (!document.fullscreenElement) toggleHud();
        return;
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [overlayBlocked, standalone, toggleHud]);
  useEffect(() => {
    const release = (event: KeyboardEvent) => {
      if (event.key === 'Control') setCtrlHeld(event.ctrlKey);
    };
    const reset = () => setCtrlHeld(false);
    const visibility = () => {
      if (document.hidden) reset();
    };
    window.addEventListener('keyup', release);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  const handlePlaybackKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      overlayBlocked ||
      e.code !== 'Space' ||
      e.defaultPrevented ||
      e.nativeEvent.isComposing ||
      e.altKey ||
      e.metaKey ||
      e.shiftKey
    )
      return;
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('input,textarea,select,button,a[href]'))
    )
      return;
    const current = stateRef.current;
    if (!current || current.phase === 'ended' || transitionBusy.current || failure || mediaError)
      return;
    const pages = activeStoryboard(getScene(p, current));
    if (!pages && e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (!pages) {
      togglePlayback();
      return;
    }
    const lastPage = pages.length - 1;
    const currentPage = storyboardAt(pages, current.positionMs);
    if (currentPage === lastPage) return;
    const nextPage = e.ctrlKey ? lastPage : currentPage + 1;
    const positionMs = pages.slice(0, nextPage).reduce((sum, page) => sum + page.durationMs, 0);
    guarded((s) => advance(p, s, positionMs));
  };
  const restoreSlot = (slot: SaveSlot) => {
    const next = loadGame(p, slot.save);
    initialNoticesPending.current = false;
    clearToasts();
    clearTransition();
    stateRef.current = next;
    setState(next);
    playtime.current = slot.playtimeMs ?? 0;
    forceAuto.current = true;
    setFailure('');
    setMediaError(false);
    resumePlayback();
    setRestoreKey((key) => key + 1);
    setSlotMode(null);
    setResumePrompt(false);
    cue('load');
    setNotice('已恢复游戏进度。');
  };
  const autoError = useRef(false);
  const writeAuto = useCallback(() => {
    const current = pendingTransitionState.current ?? stateRef.current;
    if (!autosaveAllowed.current || !current) return;
    // Opening a new preview must leave the previous resume point available until progress changes.
    if (
      !forceAuto.current &&
      current.visitSerial === initialVisit.current &&
      current.positionMs < 1000 &&
      repository.read('auto').status === 'ready'
    )
      return;
    try {
      repository.write('auto', current, '', playtime.current);
      try {
        localStorage.setItem(
          progressKey,
          JSON.stringify(mergeProgress(p, readProgress(localStorage, progressKey), current)),
        );
      } catch {
        /* The save itself still carries this route history. */
      }
      forceAuto.current = false;
      autoError.current = false;
    } catch (e) {
      if (!autoError.current) setNotice(`自动存档失败：${(e as Error).message}`, true);
      autoError.current = true;
    }
  }, [repository, setNotice, progressKey, p]);
  useEffect(() => {
    writeAuto();
  }, [state?.visitSerial, state?.phase, resumePrompt, restoreKey, writeAuto]);
  useEffect(() => {
    const timer = setInterval(writeAuto, 15000);
    const hidden = () => {
      if (document.hidden) writeAuto();
    };
    addEventListener('pagehide', writeAuto);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(timer);
      removeEventListener('pagehide', writeAuto);
      document.removeEventListener('visibilitychange', hidden);
      writeAuto();
    };
  }, [writeAuto]);
  const progressSignature = state
    ? `${state.visited.join(',')}:${state.takenChoices.join(',')}`
    : '';
  useEffect(() => {
    if (!stateRef.current || resumePrompt) return;
    try {
      const next = mergeProgress(p, readProgress(localStorage, progressKey), stateRef.current);
      localStorage.setItem(progressKey, JSON.stringify(next));
    } catch {
      /* The save itself still carries this route history. */
    }
  }, [progressSignature, progressKey, p, resumePrompt]);
  useEffect(
    () => () => {
      transitionTimers.current.forEach(clearTimeout);
      audio.current?.close();
    },
    [],
  );
  const choices = state ? availableChoices(p, state) : [];
  const choiceVisit =
    state?.phase === 'choosing' && !failure && !mediaError && choices.length
      ? `${restoreKey}:${state.visitSerial}`
      : undefined;
  const lastChoiceCue = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!choiceVisit || overlayBlocked || transitionPhase !== 'idle') return;
    if (lastChoiceCue.current === choiceVisit) return;
    lastChoiceCue.current = choiceVisit;
    audio.current?.play('choices-open', 1);
  }, [choiceVisit, overlayBlocked, transitionPhase]);
  const choiceQuestion =
    n?.kind === 'video' && choices.length ? n.choiceQuestion?.trim() : undefined;
  const preload =
    n &&
    state &&
    (state.phase === 'choosing' ||
      (state.phase === 'playing' && sceneDuration(p, n) - state.positionMs < 5000))
      ? [...new Set([...n.choices.map((c) => c.targetId), n.nextId])]
          .map((id) => p.scenes.find((n) => n.id === id))
          .map((n) => p.assets.find((a) => a.id === n?.assetId))
          .filter((a) => a?.type === 'video')
          .slice(0, 2)
      : [];
  const leaveGame = () => {
    writeAuto();
    if (onClose) onClose();
    else window.close();
  };
  const exitLabel = standalone ? '关闭游戏' : '退出试玩';
  const menuActions = [
    {
      label: '存读档',
      detail: '保存或读取游戏进度',
      Icon: FloppyDisk,
      run: () => setSlotMode('save'),
    },
    {
      label: '重新开始',
      detail: '从作品开头重新游玩',
      Icon: ArrowCounterClockwise,
      run: () => setConfirmRestart(true),
    },
    {
      label: '查看属性',
      detail: '查看角色公开属性',
      Icon: SlidersHorizontal,
      portraitOnly: true,
      disabled: !state,
      run: () => setInfoPanel('attributes'),
    },
    {
      label: '查看道具',
      detail: '查看已获得的道具',
      Icon: Backpack,
      portraitOnly: true,
      disabled: !state,
      run: () => setInfoPanel('inventory'),
    },
    {
      label: exitLabel,
      detail: standalone ? '保存进度并退出游戏' : '返回编辑器',
      Icon: X,
      portraitOnly: true,
      run: leaveGame,
    },
  ];
  const controls = (
    <div className="player-menu-controls">
      <div className="player-topbar" hidden={!hudVisible} role="region" aria-label="游戏顶部菜单">
        <div className="player-corner top-left">
          <div className="player-scene-title">
            <span>{n ? chapterTitle(p, n.chapterId) : p.title}</span>
            <h2>{n?.title ?? p.title}</h2>
          </div>
        </div>
        <div className="player-corner top-right" role="group" aria-label="游戏主要操作">
          <PlayerControl
            label={playbackPaused ? '播放' : '暂停'}
            className="player-action"
            disabled={!state || state.phase === 'ended' || overlayBlocked}
            onClick={togglePlayback}
          >
            {playbackPaused ? <Play size={26} /> : <Pause size={26} />}
          </PlayerControl>
          {!portrait && (
            <PlayerControl label={exitLabel} className="player-action" onClick={leaveGame}>
              <X size={26} />
            </PlayerControl>
          )}
        </div>
      </div>
      <div
        ref={menu}
        id="player-menu"
        className="player-hud"
        hidden={!hudVisible || portrait}
        role="region"
        aria-label="游戏操作"
      >
        <div className="player-corner bottom-left" role="group" aria-label="角色信息">
          <PlayerControl
            label="查看属性"
            className="player-action"
            disabled={!state}
            onClick={() => setInfoPanel('attributes')}
          >
            <SlidersHorizontal size={26} />
          </PlayerControl>
          <PlayerControl
            label="查看道具"
            className="player-action"
            disabled={!state}
            onClick={() => setInfoPanel('inventory')}
          >
            <Backpack size={26} />
          </PlayerControl>
        </div>
      </div>
      <button
        ref={menuEntry}
        className="button player-more-trigger"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        disabled={overlayBlocked}
        onClick={() => setMenuOpen(true)}
      >
        <Menu size={24} />
        菜单
      </button>
    </div>
  );
  return (
    <div
      ref={playerRoot}
      onKeyDown={handlePlaybackKey}
      className={`player-shell cinematic ${standalone ? 'standalone' : 'preview'} ${hudVisible ? 'menu-open' : ''} ${portrait ? 'portrait' : ''}`}
      data-choice-motion="on"
      data-node-id={state?.nodeId}
      data-position-ms={Math.round(state?.positionMs ?? 0)}
      role={standalone ? undefined : 'dialog'}
      aria-modal={standalone ? undefined : true}
      aria-label="互动作品试玩"
    >
      {controls}
      <div className="player-body">
        <div className="player-main">
          <div
            className="player-stage"
            ref={stageRef}
            role="region"
            tabIndex={0}
            aria-label="游戏画面"
            onClick={(e) => {
              if (
                overlayBlocked ||
                (e.target as HTMLElement).closest(
                  'button,a,input,select,textarea,.player-choices,[data-player-interactive]',
                )
              )
                return;
              toggleHud();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) {
                e.preventDefault();
                e.stopPropagation();
                toggleHud();
              }
            }}
          >
            {n?.timeline ? (
              <TimelineMedia
                key={`${state?.visitSerial}:${restoreKey}`}
                project={p}
                scene={n}
                playbackRate={playbackRate}
                positionMs={
                  showingChange && reachedEnd && n.timeline.videoClips.length
                    ? Math.max(0, state!.positionMs - 1)
                    : (state?.positionMs ?? 0)
                }
                playing={
                  mediaCanPlay.current &&
                  !failure &&
                  !mediaError &&
                  (state?.positionMs ?? 0) < sceneDuration(p, n)
                }
                resolveAsset={resolveAsset}
                onPosition={(position) => {
                  timelinePosition.current = {
                    visit: state!.visitSerial,
                    restore: restoreKey,
                    position,
                  };
                }}
                onError={() => setMediaError(true)}
                onBlocked={() => setPaused(true)}
              />
            ) : isVideo && asset ? (
              <video
                ref={video}
                key={`${state?.visitSerial}:${restoreKey}`}
                src={resolveAsset(asset)}
                poster={resolveAsset(asset, true)}
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  const element = e.currentTarget;
                  const current = stateRef.current;
                  if (current && n)
                    element.currentTime = (n.trimStartMs + current.positionMs) / 1000;
                  if (
                    !playbackPaused &&
                    !isWaiting &&
                    !overlayBlocked &&
                    transitionPhase === 'idle'
                  )
                    requestVideoPlay(element);
                }}
                onEnded={() => {
                  if (n && mediaCanPlay.current && !transitionBusy.current)
                    guarded((s) => advance(p, s, sceneDuration(p, n)));
                }}
                onError={() => setMediaError(true)}
              />
            ) : asset ? (
              <img className="player-still" src={resolveAsset(asset, true)} alt="" />
            ) : storyboard ? (
              <Storyboard pages={storyboard} positionMs={state?.positionMs ?? 0} />
            ) : (
              <div className="player-placeholder">
                <FilmStrip size={54} />
                <span>未绑定视频素材</span>
              </div>
            )}
            {storyboardOverlay && (
              <Storyboard pages={storyboardOverlay} positionMs={state?.positionMs ?? 0} overlay />
            )}
            <div className="player-vignette" />
            {transitionPhase !== 'idle' && (
              <div
                key={`${transitionPhase}:${state?.visitSerial}`}
                className={`scene-transition ${transitionPhase}`}
                style={{ animationDuration: `${fadeMs}ms` }}
                aria-hidden="true"
              />
            )}
            {!failure && !mediaError && state && n && (
              <>
                {playbackPaused && !overlayBlocked && state.phase !== 'ended' && (
                  <button className="resume-button" aria-label="继续播放" onClick={resumePlayback}>
                    <Play size={28} />
                  </button>
                )}
                {state.phase === 'choosing' && (
                  <div
                    className="player-choices"
                    role={choiceQuestion ? 'group' : undefined}
                    aria-labelledby={choiceQuestion ? choiceQuestionId : undefined}
                  >
                    {choiceQuestion && (
                      <h2 id={choiceQuestionId} className="player-choice-question">
                        {choiceQuestion}
                      </h2>
                    )}
                    {choices.map(({ choice: c, enabled }, i) => (
                      <button
                        key={`${state.visitSerial}:${c.id}`}
                        disabled={!enabled || overlayBlocked || transitionPhase !== 'idle'}
                        className={`player-choice ${selectedChoiceId === c.id ? 'chosen' : ''}`}
                        style={{ animationDelay: `${i * 45}ms` }}
                        onClick={() => {
                          if (transitionBusy.current) return;
                          releaseHudPause();
                          cue('choice');
                          setSelectedChoiceId(c.id);
                          guarded((s) => choose(p, s, c.id));
                        }}
                      >
                        <span className="player-choice-key">{String.fromCharCode(65 + i)}</span>
                        <span>
                          <strong>{c.label}</strong>
                          {!enabled && <small>{c.lockedText}</small>}
                        </span>
                        {enabled ? <ArrowRight size={20} /> : <LockSimple size={18} />}
                      </button>
                    ))}
                    {!choices.length && (
                      <p className="inline-note">没有可用的选项，请在编辑器中添加兜底选择。</p>
                    )}
                  </div>
                )}
                {state.phase === 'ended' && !showingChange && (
                  <div className="player-ending">
                    <Trophy size={38} />
                    <span>THE END</span>
                    <h2>{n.kind === 'ending' ? n.endingLabel : n.title}</h2>
                    {n.kind === 'ending' && n.endingText && <p>{n.endingText}</p>}
                    <Button variant="primary" onClick={() => setConfirmRestart(true)}>
                      <ArrowCounterClockwise size={16} />
                      再一次选择
                    </Button>
                    {onClose && !standalone && (
                      <Button variant="ghost" onClick={onClose}>
                        返回创作
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
            {(failure || mediaError) && (
              <div className="player-error">
                <WarningCircle size={36} />
                <h3>{mediaError ? '视频无法播放' : '剧情运行遇到问题'}</h3>
                <p>
                  {failure ||
                    '请检查素材是否存在、编码是否受支持。可尝试转为 H.264 / AAC 的 MP4 文件。'}
                </p>
                <Button onClick={() => restart()}>重新开始</Button>
                {onClose && (
                  <Button variant="ghost" onClick={onClose}>
                    返回编辑器
                  </Button>
                )}
              </div>
            )}
            <PlayerToasts
              toasts={toasts}
              paused={otherOverlayBlocked || transitionPhase !== 'idle'}
              dismiss={dismiss}
              container={playerRoot.current}
            />
          </div>
        </div>
        {debug && !standalone && state && (
          <aside className="runtime-debug">
            <h3>
              运行状态<span>LIVE</span>
            </h3>
            <div className="debug-section">
              <h4>游戏属性</h4>
              {p.variables.map((v) => (
                <div className="debug-value" key={v.id}>
                  <span>{v.name}</span>
                  <strong>{String(state.variables[v.id])}</strong>
                </div>
              ))}
            </div>
            <div className="debug-section">
              <h4>背包</h4>
              {p.items.map((i) => (
                <div className="debug-value" key={i.id}>
                  <span>
                    <Package size={14} />
                    {i.name}
                  </span>
                  <strong>× {state.inventory[i.id]}</strong>
                </div>
              ))}
            </div>
            <div className="debug-section">
              <h4>执行记录</h4>
              <div className="runtime-log">
                {[...state.log].reverse().map((entry, i) => (
                  <div key={i}>
                    <span />
                    <p>{entry.message}</p>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>
      <Modal
        container={playerRoot.current}
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open) hideMenu();
        }}
        title="游戏菜单"
        className="player-more-menu"
      >
        <div className="player-more-actions">
          {menuActions
            .filter(({ portraitOnly }) => portrait || !portraitOnly)
            .map(({ label, detail, Icon, disabled, run }) => (
              <button
                key={label}
                aria-label={label}
                disabled={disabled}
                onClick={() => {
                  setMenuOpen(false);
                  run();
                }}
              >
                <Icon size={22} />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ))}
          <button
            aria-label="剧情路线"
            onClick={() => {
              setMenuOpen(false);
              setRouteOpen(true);
            }}
            disabled={!state}
          >
            <Graph size={22} />
            <span>
              <strong>剧情路线</strong>
              <small>查看已探索的故事路径</small>
            </span>
          </button>
          <button
            aria-label={fullscreen ? '退出全屏' : '全屏画面'}
            onClick={async () => {
              setMenuOpen(false);
              try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await playerRoot.current?.requestFullscreen();
              } catch {
                setNotice('无法切换全屏，请稍后重试。', true);
              }
            }}
          >
            <span className="player-more-icon">
              {fullscreen ? <ArrowsIn size={22} /> : <ArrowsOut size={22} />}
            </span>
            <span>
              <strong>{fullscreen ? '退出全屏' : '全屏画面'}</strong>
              <small>{fullscreen ? '恢复窗口显示' : '让游戏铺满屏幕'}</small>
            </span>
          </button>
          <button
            aria-label="作品信息"
            onClick={() => {
              setMenuOpen(false);
              setInfoPanel('about');
            }}
          >
            <Info size={22} />
            <span>
              <strong>作品信息</strong>
              <small>查看作品简介和作者</small>
            </span>
          </button>
          {!standalone && (
            <>
              <button
                aria-label="测试初始值"
                onClick={() => {
                  setMenuOpen(false);
                  setTesting(true);
                }}
              >
                <FlaskConical size={22} />
                <span>
                  <strong>测试初始值</strong>
                  <small>使用指定属性和道具重新试玩</small>
                </span>
              </button>
              <button
                aria-label="运行状态"
                onClick={() => {
                  setMenuOpen(false);
                  setDebug(!debug);
                }}
                aria-pressed={debug}
              >
                <Bug size={22} />
                <span>
                  <strong>运行状态</strong>
                  <small>检查属性、背包及执行记录</small>
                </span>
              </button>
            </>
          )}
        </div>
      </Modal>
      {preload.map((a) => (
        <video
          key={a!.id}
          className="preload-video"
          muted
          preload="metadata"
          src={resolveAsset(a)}
        />
      ))}
      <Modal
        container={playerRoot.current}
        open={!!infoPanel}
        onOpenChange={(open) => !open && setInfoPanel(null)}
        title={
          infoPanel === 'attributes' ? '属性' : infoPanel === 'inventory' ? '道具' : '作品信息'
        }
      >
        {infoPanel === 'attributes' &&
          state &&
          (visibleVariables.length ? (
            <dl className="player-attributes">
              {visibleVariables.map((variable) => (
                <div key={variable.id}>
                  <dt>{variable.name}</dt>
                  <dd>
                    {typeof state.variables[variable.id] === 'boolean'
                      ? state.variables[variable.id]
                        ? '开启'
                        : '关闭'
                      : String(state.variables[variable.id] ?? '') || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="player-data-empty">
              <SlidersHorizontal size={30} />
              <span>暂无属性</span>
            </div>
          ))}
        {infoPanel === 'inventory' &&
          state &&
          (p.items.some((item) => state.inventory[item.id] > 0) ? (
            <div className="player-inventory">
              {p.items
                .filter((item) => state.inventory[item.id] > 0)
                .map((item) => (
                  <article key={item.id}>
                    <Package size={22} />
                    <div>
                      <strong>{item.name}</strong>
                      {item.description && <p>{item.description}</p>}
                    </div>
                    <span>× {state.inventory[item.id]}</span>
                  </article>
                ))}
            </div>
          ) : (
            <div className="player-data-empty">
              <Backpack size={30} />
              <span>背包为空</span>
            </div>
          ))}
        {infoPanel === 'about' && (
          <div className="player-about">
            <h3>{p.title}</h3>
            {p.settings.author && <span>{p.settings.author}</span>}
            {p.description && <p>{p.description}</p>}
            {p.assets.some((asset) => asset.builtin && asset.path.startsWith('demo/')) && (
              <small>
                示例影片：© 2008 Blender Foundation / www.bigbuckbunny.org · CC BY 3.0（片段改编）
              </small>
            )}
          </div>
        )}
      </Modal>
      <Modal
        container={playerRoot.current}
        open={!!slotMode}
        onOpenChange={(v) => !v && setSlotMode(null)}
        title="存读档"
        wide
      >
        <div
          className="save-mode-tabs"
          role="tablist"
          aria-label="存读档操作"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 'save'
                : event.key === 'End'
                  ? 'load'
                  : slotMode === 'save'
                    ? 'load'
                    : 'save';
            setSlotMode(next);
            event.currentTarget
              .querySelectorAll<HTMLButtonElement>('button')
              [next === 'save' ? 0 : 1]?.focus();
          }}
        >
          <button
            role="tab"
            aria-selected={slotMode === 'save'}
            tabIndex={slotMode === 'save' ? 0 : -1}
            aria-controls="player-save-slots"
            onClick={() => setSlotMode('save')}
          >
            存档
          </button>
          <button
            role="tab"
            aria-selected={slotMode === 'load'}
            tabIndex={slotMode === 'load' ? 0 : -1}
            aria-controls="player-save-slots"
            onClick={() => setSlotMode('load')}
          >
            读档
          </button>
        </div>
        {slotMode && (
          <div
            role="tabpanel"
            aria-label={slotMode === 'save' ? '存档' : '读档'}
            id="player-save-slots"
          >
            <SaveManager
              key={slotMode}
              project={p}
              repository={repository}
              mode={slotMode}
              state={transitionPhase === 'idle' ? state : null}
              playtimeMs={playtime.current}
              resolveThumbnail={(id) => {
                const scene = p.scenes.find((s) => s.id === id);
                const asset = p.assets.find((a) => a.id === scene?.assetId);
                return asset ? resolveAsset(asset, true) : '';
              }}
              onRestore={restoreSlot}
              onSaved={() => {
                setSlotMode(null);
                cue('save');
                setNotice('进度已保存。');
              }}
            />
          </div>
        )}
      </Modal>
      <Modal
        container={playerRoot.current}
        open={routeOpen}
        onOpenChange={setRouteOpen}
        title="剧情路线"
        className="route-dialog"
        wide
      >
        {state && <RouteOverview project={p} state={state} />}
      </Modal>
      <Modal
        container={playerRoot.current}
        open={resumePrompt}
        onOpenChange={(v) => {
          if (!v) setResumePrompt(false);
        }}
        title="继续上次游戏？"
      >
        <p className="playback-hint">{resumeCandidate.current?.title}</p>
        <div className="dialog-actions">
          <Button
            onClick={() => {
              setResumePrompt(false);
              resumePlayback();
            }}
          >
            从头开始
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              try {
                if (resumeCandidate.current) restoreSlot(resumeCandidate.current);
              } catch (e) {
                setNotice((e as Error).message, true);
              }
            }}
          >
            继续游戏
          </Button>
        </div>
      </Modal>
      <Modal
        container={playerRoot.current}
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="重新开始游戏？"
      >
        <p className="playback-hint">将从故事起点开始新一局。手动存档和探索记录会保留。</p>
        <div className="dialog-actions">
          <Button onClick={() => setConfirmRestart(false)}>取消</Button>
          <Button variant="primary" onClick={() => restart(p.startNodeId)}>
            确认重新开始
          </Button>
        </div>
      </Modal>
      <Modal
        container={playerRoot.current}
        open={testing}
        onOpenChange={setTesting}
        title="测试初始状态"
      >
        <div className="test-values">
          {p.variables.map((v) => (
            <Field label={v.name} key={v.id}>
              <ValueInput
                type={v.type}
                value={testVariables[v.id] ?? v.initial}
                onChange={(value) => setTestVariables({ ...testVariables, [v.id]: value })}
              />
            </Field>
          ))}
          {p.items.map((i) => (
            <Field label={`${i.name} · 数量`} key={i.id}>
              <input
                type="number"
                min="0"
                value={testItems[i.id] ?? i.initial}
                onChange={(e) =>
                  setTestItems({
                    ...testItems,
                    [i.id]: Math.max(0, Math.floor(Number(e.target.value))),
                  })
                }
              />
            </Field>
          ))}
        </div>
        <div className="dialog-actions">
          <Button onClick={() => setTesting(false)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              try {
                clearTransition();
                playtime.current = 0;
                const next = start(p, from, { variables: testVariables, inventory: testItems });
                initialNoticesPending.current = false;
                clearToasts();
                notifyEntry(next);
                stateRef.current = next;
                setState(next);
                setRestoreKey((k) => k + 1);
                resumePlayback();
                setTesting(false);
                setFailure('');
              } catch (e) {
                setNotice((e as Error).message, true);
              }
            }}
          >
            用此状态开始
            <Play size={14} />
          </Button>
        </div>
      </Modal>
    </div>
  );
}
