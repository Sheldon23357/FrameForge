import { useState } from 'react';
import {
  BookOpen,
  FolderOpen,
  Image,
  MagnifyingGlass,
  MapPin,
  Plus,
  SpinnerGap,
  User,
  Waveform,
} from '@phosphor-icons/react';
import type { Asset, Project, WorldSetting } from '../../../packages/domain/schema';
import {
  createWorldSetting,
  deleteWorldSetting,
  findWorldSetting,
  matchesWorldSetting,
  updateWorldSetting,
  type WorldReferenceKind,
} from '../../../packages/domain/world-settings';
import { Button, Empty, Field, Modal } from '../../components/ui';
import { assetUrl, isDesktop, platform } from '../../platform';
import { useEditor } from '../../store/editor';
import { useWorldReferences } from '../../store/world-reference';
import './world-settings.css';

const kinds = ['character', 'location'] as const;
const referenceKinds = ['image', 'audio'] as const;
const referenceFields = { image: 'imageAssetId', audio: 'audioAssetId' } as const;
const fileLabels = { image: '选择图片文件', audio: '选择音频文件' };
const labels = {
  character: {
    name: '角色',
    description: '身份与性格',
    visual: '角色形象',
    sound: '声音描述',
    audio: '声音样本',
    createAudio: '创建示例音频',
    createImage: '生成定妆参考图',
    icon: User,
  },
  location: {
    name: '场景',
    description: '背景与用途',
    visual: '空间与画面',
    sound: '环境声音',
    audio: '环境声样本',
    createAudio: '生成环境声',
    createImage: '生成场景参考图',
    icon: MapPin,
  },
};

function useReferencePicker(settingKind: WorldSetting['kind']) {
  const [picking, setPicking] = useState<WorldReferenceKind>();
  const pick = async (
    kind: WorldReferenceKind,
    apply: (asset: Asset) => void,
    report: (error: string) => void,
  ) => {
    if (picking) return;
    const { projectLoadSerial } = useEditor.getState();
    const sameProject = () => useEditor.getState().projectLoadSerial === projectLoadSerial;
    setPicking(kind);
    try {
      const audioCategory =
        kind === 'audio' ? (settingKind === 'character' ? 'voice' : 'sound') : undefined;
      const [asset] = await platform.importAssets(kind, audioCategory);
      if (asset && sameProject()) apply(asset);
    } catch (cause) {
      if (sameProject()) report(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(undefined);
    }
  };
  return { pick, picking };
}

function SettingEditor({
  project,
  kind,
  original,
  onClose,
  onSave,
}: {
  project: Project;
  kind: WorldSetting['kind'];
  original?: WorldSetting;
  onClose: () => void;
  onSave: (setting: WorldSetting) => void;
}) {
  const [fields, setFields] = useState({
    name: original?.name ?? '',
    description: original?.description ?? '',
    visual: original?.visual ?? '',
    sound: original?.sound ?? '',
    imagePrompt: original?.imagePrompt ?? '',
    imageAssetId: original?.imageAssetId ?? null,
    audioAssetId: original?.audioAssetId ?? null,
  });
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Partial<Record<WorldReferenceKind, Asset>>>({});
  const { pick, picking } = useReferencePicker(kind);
  const label = labels[kind];
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !picking && onClose()}
      title={`${original ? '编辑' : '新建'}${label.name}设定`}
      wide
      className="world-setting-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (picking) return;
          try {
            let saved: WorldSetting | undefined;
            useEditor.getState().commit(
              (draft) => {
                if (
                  original &&
                  JSON.stringify(findWorldSetting(draft, original.id)) !== JSON.stringify(original)
                )
                  throw new Error('这条设定已被更新，请重新打开编辑。');
                for (const type of referenceKinds) {
                  const asset = picked[type];
                  if (
                    asset &&
                    fields[referenceFields[type]] === asset.id &&
                    !draft.assets.some((entry) => entry.id === asset.id)
                  )
                    draft.assets.push(asset);
                }
                saved = original
                  ? updateWorldSetting(draft, original.id, fields)
                  : createWorldSetting(draft, kind, fields);
              },
              undefined,
              `${original ? '编辑' : '新建'}${label.name}设定`,
            );
            if (saved) onSave(saved);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      >
        <Field label={`${label.name}名称`}>
          <input
            autoFocus
            required
            maxLength={120}
            value={fields.name}
            onChange={(event) => setFields({ ...fields, name: event.target.value })}
          />
        </Field>
        {(['description', 'visual', 'sound'] as const).map((field) => (
          <Field key={field} label={label[field]}>
            <textarea
              rows={3}
              maxLength={2400}
              placeholder={
                kind === 'character' && field === 'visual'
                  ? '年龄感、五官、发型、体态、日常服饰和辨识特征'
                  : undefined
              }
              value={fields[field]}
              onChange={(event) => setFields({ ...fields, [field]: event.target.value })}
            />
          </Field>
        ))}
        <Field label="绘图提示词">
          <textarea
            rows={3}
            maxLength={2400}
            placeholder="可选。为参考图补充表现细节，作品画风和参考图版式会自动应用"
            value={fields.imagePrompt}
            onChange={(event) => setFields({ ...fields, imagePrompt: event.target.value })}
          />
        </Field>
        <div className="world-setting-references">
          {referenceKinds.map((type) => {
            const field = referenceFields[type];
            const asset = picked[type];
            return (
              <div key={type}>
                <Field label={type === 'image' ? '参考图（横向 3:2）' : label.audio}>
                  <select
                    value={fields[field] ?? ''}
                    onChange={(event) =>
                      setFields({ ...fields, [field]: event.target.value || null })
                    }
                  >
                    <option value="">未选择</option>
                    {asset && !project.assets.some((entry) => entry.id === asset.id) && (
                      <option value={asset.id}>{asset.name}</option>
                    )}
                    {project.assets
                      .filter((asset) => asset.type === type)
                      .map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  busy={picking === type}
                  disabled={!!picking}
                  onClick={() => {
                    setError('');
                    void pick(
                      type,
                      (asset) => {
                        setPicked((previous) => ({ ...previous, [type]: asset }));
                        setFields((previous) => ({ ...previous, [field]: asset.id }));
                      },
                      setError,
                    );
                  }}
                >
                  <FolderOpen size={16} aria-hidden />
                  {fileLabels[type]}
                </Button>
              </div>
            );
          })}
        </div>
        {error && (
          <p className="world-setting-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" disabled={!!picking} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={!!picking || !fields.name.trim()}>
            保存设定
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SettingDetail({
  project,
  setting,
  onEdit,
  onDelete,
}: {
  project: Project;
  setting: WorldSetting;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const label = labels[setting.kind];
  const Icon = label.icon;
  const jobs = useWorldReferences((state) => state.jobs);
  const generate = useWorldReferences((state) => state.generate);
  const cancel = useWorldReferences((state) => state.cancel);
  const { pick, picking } = useReferencePicker(setting.kind);
  const image = project.assets.find((asset) => asset.id === setting.imageAssetId);
  const audio = project.assets.find((asset) => asset.id === setting.audioAssetId);
  const referenceButton = (kind: WorldReferenceKind, description?: string) => {
    const buttonText = kind === 'image' ? label.createImage : label.createAudio;
    const MediaIcon = kind === 'image' ? Image : Waveform;
    const job = jobs.find((entry) => entry.settingId === setting.id && entry.kind === kind);
    const unavailableHint = !isDesktop
      ? '请在桌面版生成参考素材'
      : !description?.trim()
        ? '请先在设定中填写对应描述'
        : undefined;
    const jobHint = job?.status === 'queued' ? '排队中，点击取消' : '生成中，点击取消';
    return (
      <div className="world-setting-generation">
        <Button
          onClick={job ? () => cancel(job.id) : () => void generate(setting.id, kind, buttonText)}
          disabled={!job && (!!unavailableHint || picking === kind)}
          aria-label={
            job ? `取消${setting.name}的${kind === 'image' ? '参考图' : '音频'}` : undefined
          }
          title={job ? jobHint : unavailableHint}
        >
          {job ? (
            <SpinnerGap className="spin" size={16} aria-hidden />
          ) : (
            <MediaIcon size={16} aria-hidden />
          )}
          {job ? '取消' : buttonText}
        </Button>
        <Button
          busy={picking === kind}
          disabled={!!picking || !!job}
          onClick={() =>
            void pick(
              kind,
              (asset) => {
                const editor = useEditor.getState();
                const field = referenceFields[kind];
                editor.commit(
                  (draft) => {
                    if (findWorldSetting(draft, setting.id)[field] !== setting[field])
                      throw new Error('参考素材已更改，请重新选择文件。');
                    if (!draft.assets.some((entry) => entry.id === asset.id))
                      draft.assets.push(asset);
                    updateWorldSetting(draft, setting.id, { [field]: asset.id });
                  },
                  undefined,
                  fileLabels[kind],
                );
              },
              (error) => useEditor.getState().notify(error, 'error'),
            )
          }
        >
          <FolderOpen size={16} aria-hidden />
          {fileLabels[kind]}
        </Button>
      </div>
    );
  };
  return (
    <article className="world-setting-detail" aria-label="设定详情">
      <header className="world-setting-title">
        <div className="world-setting-symbol">
          <Icon size={24} weight="duotone" aria-hidden />
        </div>
        <div>
          <span>{label.name}设定</span>
          <h2>{setting.name}</h2>
        </div>
        <div className="world-setting-actions">
          <Button variant="ghost" onClick={onDelete}>
            删除
          </Button>
          <Button onClick={onEdit}>编辑设定</Button>
        </div>
      </header>
      <dl className="world-setting-copy">
        {(['description', 'visual', 'sound'] as const).map((field) => (
          <div key={field}>
            <dt>{label[field]}</dt>
            <dd>
              <p className={setting[field] ? undefined : 'world-setting-muted'}>
                {setting[field] || '待补充'}
              </p>
              {field === 'visual' && (
                <>
                  {referenceButton('image', setting.visual)}
                  {image && (
                    <figure className="world-setting-image">
                      <img src={assetUrl(image)} alt={`${setting.name}的参考图`} />
                      <figcaption>{image.name}</figcaption>
                    </figure>
                  )}
                </>
              )}
              {field === 'sound' && (
                <>
                  {referenceButton('audio', setting.sound)}
                  {audio && (
                    <audio
                      className="world-setting-audio"
                      key={audio.id}
                      aria-label={label.audio}
                      controls
                      loop={setting.kind === 'location'}
                      preload="none"
                      src={assetUrl(audio)}
                    />
                  )}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export function WorldSettings() {
  const project = useEditor((state) => state.project);
  const [kind, setKind] = useState<WorldSetting['kind']>('character');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [edit, setEdit] = useState<{ original?: WorldSetting }>();
  const [remove, setRemove] = useState<WorldSetting>();
  const entries = project.worldSettings ?? [];
  const rows = entries.filter(
    (setting) => setting.kind === kind && matchesWorldSetting(setting, query),
  );
  const selected = rows.find((entry) => entry.id === selectedId) ?? rows[0];
  const Icon = labels[kind].icon;
  return (
    <main className="data-page world-settings">
      <div className="page-heading">
        <h1>设定</h1>
      </div>
      <div className="data-toolbar">
        <div className="data-tabs" role="group" aria-label="设定类型">
          {kinds.map((value) => {
            const TabIcon = labels[value].icon;
            return (
              <button
                key={value}
                aria-pressed={kind === value}
                className={kind === value ? 'active' : ''}
                onClick={() => setKind(value)}
              >
                <TabIcon size={17} aria-hidden />
                {labels[value].name}
                <span>{entries.filter((entry) => entry.kind === value).length}</span>
              </button>
            );
          })}
        </div>
        <Button variant="primary" onClick={() => setEdit({})}>
          <Plus size={16} />
          新建{labels[kind].name}
        </Button>
      </div>
      <div className="data-content">
        <div className="search-input">
          <MagnifyingGlass size={16} />
          <input
            type="search"
            aria-label="搜索设定"
            placeholder="搜索名称或描述"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {selected ? (
          <div className="world-settings-layout">
            <ul className="world-setting-list" aria-label="设定列表">
              {rows.map((entry) => (
                <li key={entry.id}>
                  <button
                    className="world-setting-row"
                    aria-current={selected.id === entry.id ? 'true' : undefined}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <Icon size={17} aria-hidden />
                    <span>
                      <strong>{entry.name}</strong>
                      {entry.description && <small>{entry.description}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <SettingDetail
              key={selected.id}
              project={project}
              setting={selected}
              onEdit={() => setEdit({ original: selected })}
              onDelete={() => setRemove(selected)}
            />
          </div>
        ) : (
          <Empty icon={query ? <MagnifyingGlass size={35} /> : <BookOpen size={35} />}>
            {query ? '没有匹配的设定' : `还没有${labels[kind].name}设定`}
          </Empty>
        )}
      </div>
      {edit && (
        <SettingEditor
          project={project}
          kind={kind}
          original={edit.original}
          onClose={() => setEdit(undefined)}
          onSave={(setting) => {
            setSelectedId(setting.id);
            setQuery('');
            setEdit(undefined);
          }}
        />
      )}
      {remove && (
        <Modal
          open
          title="删除设定"
          description={`删除「${remove.name}」会同时解除它与剧情节点的关联。`}
          onOpenChange={(open) => !open && setRemove(undefined)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setRemove(undefined)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                const editor = useEditor.getState();
                try {
                  editor.commit(
                    (draft) => deleteWorldSetting(draft, remove.id),
                    undefined,
                    '删除设定',
                  );
                  setRemove(undefined);
                } catch (error) {
                  editor.notify(error instanceof Error ? error.message : String(error), 'error');
                }
              }}
            >
              删除设定
            </Button>
          </div>
        </Modal>
      )}
    </main>
  );
}
