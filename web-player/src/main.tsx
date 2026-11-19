import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '../../src/styles/base.css';
import '../../src/styles/inspector.css';
import '../../src/styles/overlays.css';
import '../../src/styles/player.css';
import './style.css';
import { parseProject, type Project } from '../../packages/domain/schema';
import { webAssetPath } from '../../packages/export/web';
import { Player } from '../../src/features/player/Player';
import type { Asset } from '../../packages/domain/schema';
import { SaveRepository, type SaveSlot } from '../../src/features/player/saves';

// Resolve from the deployed page, so domain roots and nested directories both work.
const gameBase = new URL('./game/', document.baseURI);
function resolveAsset(asset: Asset | undefined, thumbnail = false) {
  if (!asset) return '';
  const relative = thumbnail ? (asset.thumbnail ?? asset.path) : asset.path;
  if (relative.startsWith('data:')) return relative;
  const encoded = webAssetPath(relative).split('/').map(encodeURIComponent).join('/');
  return new URL(`files/${encoded}`, gameBase).href;
}

function WebGame() {
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const [resume, setResume] = useState<SaveSlot>();
  const [latest, setLatest] = useState<SaveSlot>();
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(new URL('project.json', gameBase), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`无法读取游戏数据（HTTP ${response.status}）。`);
        const next = parseProject(await response.json());
        // Validate every media path before entering the player.
        next.assets.forEach((asset) => {
          resolveAsset(asset);
          resolveAsset(asset, true);
        });
        document.title = next.title;
        setProject(next);
        setLatest(new SaveRepository(localStorage, next).latest());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);
  if (started && project)
    return (
      <Player
        project={project}
        standalone
        resolveAsset={resolveAsset}
        initialSave={resume}
        offerResume={false}
        onClose={() => {
          setStarted(false);
          setResume(undefined);
          // Player writes its latest automatic save before invoking this callback.
          setLatest(new SaveRepository(localStorage, project).latest());
        }}
      />
    );
  return (
    <main className="web-start">
      <h1>{error ? '游戏未能加载' : (project?.title ?? '正在加载游戏…')}</h1>
      <p>{error || project?.description}</p>
      {error ? (
        <button className="button" onClick={() => location.reload()}>
          重新加载
        </button>
      ) : (
        <>
          {latest && (
            <button
              className="button primary"
              onClick={() => {
                setResume(latest);
                setStarted(true);
              }}
            >
              继续游戏
            </button>
          )}
          <button
            className={`button ${latest ? '' : 'primary'}`}
            disabled={!project}
            onClick={() => {
              setResume(undefined);
              setStarted(true);
            }}
          >
            开始游戏
          </button>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<WebGame />);
