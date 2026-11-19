import { useEffect, useRef, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Chapters } from './Chapters';
import { AssetAudioBar } from './AssetAudioBar';
import {
  MagnifyingGlass,
  UploadSimple,
  FilmStrip,
  SquaresFour,
  List,
  Image,
  FolderOpen,
  Trash,
  SidebarSimple,
} from '@phosphor-icons/react';
import { useEditor } from '../../store/editor';
import { useProjectActions } from '../project/actions';
import { assetUrl, isDesktop } from '../../platform';
import { Button, IconButton, Modal, time, bytes } from '../../components/ui';
import {
  assetCategories,
  audioAssetCategories,
  assetInUse,
  filterAssets,
  removeAsset,
  type AssetCategory,
} from '../../../packages/domain/assets';

const categoryLabels = {
  all: '全部',
  video: '视频',
  image: '图片',
  music: '音乐',
  voice: '语音',
  sound: '音效',
  reference: '设定图',
} satisfies Record<'all' | AssetCategory, string>;

export function Library({ visible, onCollapse }: { visible: boolean; onCollapse(): void }) {
  const p = useEditor((s) => s.project);
  const tab = useEditor((s) => s.libraryTab);
  const loadSerial = useEditor((s) => s.projectLoadSerial);
  const playing = useEditor((s) => s.playing);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | AssetCategory>('all');
  const [compact, setCompact] = useState(false);
  const [menu, setMenu] = useState<{ assetId: string; x: number; y: number; serial: number }>();
  const [pendingDelete, setPendingDelete] = useState<{ assetId: string; serial: number }>();
  const menuCard = useRef<HTMLDivElement>(null);
  const audition = useRef<HTMLAudioElement>(null);
  const onAudition = (audio: HTMLAudioElement) => {
    if (audition.current !== audio) audition.current?.pause();
    audition.current = audio;
  };
  useEffect(() => {
    if (playing || !visible) audition.current?.pause();
    if (!visible) setMenu(undefined);
  }, [playing, visible]);
  const { importAssets, busy } = useProjectActions();
  const audioCategory = audioAssetCategories.find((kind) => kind === category);
  const importMedia = () => void importAssets(audioCategory);
  const assets =
    tab === 'assets'
      ? filterAssets(p, { category: category === 'all' ? undefined : category, query: search })
      : [];
  const menuAsset =
    menu?.serial === loadSerial ? assets.find((asset) => asset.id === menu.assetId) : undefined;
  const deleteAsset =
    pendingDelete?.serial === loadSerial
      ? p.assets.find((asset) => asset.id === pendingDelete.assetId)
      : undefined;
  const inUse = deleteAsset && assetInUse(p, deleteAsset.id);
  const openMenu = (assetId: string, card: HTMLDivElement, x: number, y: number) => {
    menuCard.current = card;
    setMenu({ assetId, x, y, serial: loadSerial });
  };
  const revealAsset = async (assetId: string) => {
    try {
      await window.frameforge?.revealAsset(p.id, assetId);
    } catch (error) {
      useEditor.getState().notify((error as Error).message, 'error');
    }
  };
  return (
    <aside className="library-panel" aria-label="创作资源">
      <div className="panel-title">
        <h2>创作资源</h2>
        <div className="library-panel-actions">
          <span className="library-panel-count">
            {tab === 'assets' ? p.assets.length : p.scenes.length}
          </span>
          <IconButton
            label="折叠创作资源"
            aria-expanded={true}
            aria-controls="creative-library"
            onClick={onCollapse}
          >
            <SidebarSimple size={16} />
          </IconButton>
        </div>
      </div>
      <div className="segmented">
        <button
          className={tab === 'assets' ? 'active' : ''}
          onClick={() => useEditor.setState({ libraryTab: 'assets' })}
        >
          素材库
        </button>
        <button
          className={tab === 'scenes' ? 'active' : ''}
          onClick={() => useEditor.setState({ libraryTab: 'scenes' })}
        >
          故事大纲
        </button>
      </div>
      <div className="search-input">
        <MagnifyingGlass size={15} />
        <input
          placeholder={tab === 'assets' ? '搜索素材…' : '搜索节点…'}
          aria-label="搜索创作资源"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>⌕</kbd>
      </div>
      {tab === 'assets' ? (
        <>
          <Button className="import-button" busy={busy === 'import'} onClick={importMedia}>
            <UploadSimple size={17} />
            {audioCategory ? `导入${categoryLabels[audioCategory]}` : '导入视频 / 图片 / 音频'}
          </Button>
          <div className="asset-categories" role="group" aria-label="素材分类">
            {(['all', ...assetCategories] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                {categoryLabels[value]}
              </button>
            ))}
          </div>
          <div className="library-subtitle">
            <span>{assets.length} 个素材</span>
            <div>
              <IconButton
                label="缩略图视图"
                aria-pressed={!compact}
                className={!compact ? 'active' : ''}
                onClick={() => setCompact(false)}
              >
                <SquaresFour size={13} />
              </IconButton>
              <IconButton
                label="列表视图"
                aria-pressed={compact}
                className={compact ? 'active' : ''}
                onClick={() => setCompact(true)}
              >
                <List size={14} />
              </IconButton>
            </div>
          </div>
          <div
            key={`${loadSerial}:${category}`}
            className={`asset-list${compact ? ' compact' : ''}${audioCategory ? ' audio-only' : ''}`}
          >
            {assets.length ? (
              assets.map((a) => (
                <div
                  className={`asset-card${a.type === 'audio' ? ' asset-card-audio' : ''}`}
                  draggable
                  tabIndex={0}
                  aria-haspopup="menu"
                  key={a.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(a.id, e.currentTarget, e.clientX, e.clientY);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
                    e.preventDefault();
                    const { left, bottom } = e.currentTarget.getBoundingClientRect();
                    openMenu(a.id, e.currentTarget, left, bottom);
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/frameforge-asset', a.id);
                    e.dataTransfer.effectAllowed = 'copy';
                    e.currentTarget.classList.add('dragging');
                    useEditor.setState({ draggedAssetId: a.id });
                  }}
                  onDragEnd={(e) => {
                    e.currentTarget.classList.remove('dragging');
                    useEditor.setState({ draggedAssetId: undefined });
                  }}
                  onDoubleClick={() => {
                    if (a.type !== 'audio') useEditor.getState().addScene('video', undefined, a.id);
                    else useEditor.getState().notify('双击视频节点进入时间线，再添加 BGM。');
                  }}
                  title={a.name}
                >
                  {a.type === 'audio' ? (
                    <AssetAudioBar asset={a} onAudition={onAudition} />
                  ) : (
                    <>
                      <div className="asset-thumbnail">
                        {a.thumbnail ? (
                          <img src={assetUrl(a, true)} alt="" loading="lazy" decoding="async" />
                        ) : (
                          <FilmStrip size={27} weight="thin" />
                        )}
                        {a.type === 'video' && <span>{time(a.durationMs)}</span>}
                        <button
                          className="asset-add"
                          aria-label={`从 ${a.name} 创建节点`}
                          onClick={() => useEditor.getState().addScene('video', undefined, a.id)}
                        >
                          ＋
                        </button>
                      </div>
                      <div className="asset-caption">
                        <div>
                          {a.type === 'video' ? <FilmStrip size={13} /> : <Image size={13} />}
                          <strong>{a.name}</strong>
                        </div>
                        <span>
                          {a.width ? a.width + ' × ' + a.height : bytes(a.size)}
                          <span> · {a.type.toUpperCase()}</span>
                        </span>
                      </div>
                    </>
                  )}
                </div>
              ))
            ) : search || category !== 'all' ? (
              <div className="empty-state">
                <MagnifyingGlass size={28} weight="thin" />
                <strong>{search ? '无匹配素材' : '此分类暂无素材'}</strong>
              </div>
            ) : (
              <button
                className="asset-empty"
                aria-label="导入素材"
                onClick={importMedia}
                disabled={!!busy}
              >
                <span>
                  <UploadSimple size={34} weight="thin" />
                </span>
              </button>
            )}
          </div>
        </>
      ) : (
        <Chapters search={search} />
      )}
      {visible && menu && menuAsset && (
        <Dropdown.Root open onOpenChange={(open) => !open && setMenu(undefined)} modal={false}>
          <Dropdown.Trigger asChild>
            <span className="asset-menu-anchor" style={{ left: menu.x, top: menu.y }} />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              className="dropdown-content"
              aria-label="素材操作"
              align="start"
              collisionPadding={8}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                menuCard.current?.focus({ preventScroll: true });
              }}
            >
              {isDesktop && (
                <Dropdown.Item onSelect={() => void revealAsset(menuAsset.id)}>
                  <FolderOpen />
                  在文件夹中查看
                </Dropdown.Item>
              )}
              <Dropdown.Item onSelect={() => setPendingDelete(menu)}>
                <Trash />
                删除素材
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      )}
      {deleteAsset && (
        <Modal
          open
          title="删除素材"
          description={
            inUse
              ? `「${deleteAsset.name}」仍被节点、时间线、设定或制作镜头引用，请先移除或替换引用。`
              : `将「${deleteAsset.name}」从素材库移除，保留磁盘文件。此操作可撤销。`
          }
          onOpenChange={(open) => !open && setPendingDelete(undefined)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setPendingDelete(undefined)}>{inUse ? '关闭' : '取消'}</Button>
            {!inUse && (
              <Button
                variant="danger"
                onClick={() => {
                  try {
                    useEditor.getState().commit(
                      (draft) => {
                        removeAsset(draft, deleteAsset.id);
                      },
                      undefined,
                      '删除素材',
                    );
                    setPendingDelete(undefined);
                  } catch (error) {
                    useEditor.getState().notify((error as Error).message, 'error');
                  }
                }}
              >
                删除素材
              </Button>
            )}
          </div>
        </Modal>
      )}
    </aside>
  );
}
