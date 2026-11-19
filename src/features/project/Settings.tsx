import { useState } from 'react';
import { useEditor } from '../../store/editor';
import { Button, Field, Section } from '../../components/ui';
import { isDesktop } from '../../platform';
import {
  artStylePresets,
  artStylePresetSchema,
  artStyleSchema,
  atmosphereToneMaxLength,
} from '../../../packages/domain/art-style';
import { projectAspect, projectAspectPresets } from '../../../packages/domain/project-aspect';
import {
  creativeStyleGroups,
  creativeVisualStyleSchema,
  updateCreativeDefaults,
  type CreativeDefaults,
} from '../../../packages/domain/creative-options';
import { CreativeOptionsForm } from './CreativeOptionsForm';
import { commitAgentTransaction } from '../agent/editor-host';

function authoringDefaults(defaults?: CreativeDefaults) {
  const { visualStyle: _visualStyle, ...values } = defaults ?? {};
  return values;
}

export function Settings() {
  const p = useEditor((s) => s.project);
  const commit = useEditor((s) => s.commit);
  const savedPreset = p.settings.artStyle?.preset;
  const selectablePreset = artStylePresetSchema.safeParse(savedPreset);
  const savedReference = p.settings.creativeDefaults?.visualStyle;
  const legacyReference =
    savedReference &&
    !Object.values(creativeStyleGroups).some((group) =>
      group.some((name) => name === savedReference),
    );
  const aspect = projectAspect(p.settings.width, p.settings.height);
  const [draft, setDraft] = useState<{
    projectId: string;
    base: string;
    options: CreativeDefaults;
  }>();
  const defaults = authoringDefaults(p.settings.creativeDefaults);
  const savedDefaults = JSON.stringify(defaults);
  const editing = draft?.projectId === p.id ? draft : undefined;
  const editDefaults = (options: CreativeDefaults) =>
    setDraft({ projectId: p.id, base: editing?.base ?? savedDefaults, options });
  const saveDefaults = () => {
    if (!editing) return;
    const editor = useEditor.getState();
    if (
      editing.projectId !== editor.project.id ||
      editing.base !== JSON.stringify(authoringDefaults(editor.project.settings.creativeDefaults))
    ) {
      editor.notify('创作默认值已有更新，请取消当前编辑后重试。', 'error');
      return;
    }
    const project = structuredClone(editor.project);
    updateCreativeDefaults(project.settings, null);
    updateCreativeDefaults(project.settings, {
      ...editing.options,
      visualStyle: editor.project.settings.creativeDefaults?.visualStyle,
      genre: editing.options.genre?.trim() || undefined,
    });
    if (
      JSON.stringify(authoringDefaults(project.settings.creativeDefaults)) !== editing.base &&
      !commitAgentTransaction(editor.project, project, [], editor.changeSerial)
    ) {
      editor.notify('创作默认值未保存，请结束试玩或等待工程操作完成后重试。', 'error');
      return;
    }
    setDraft(undefined);
  };
  return (
    <main className="settings-page">
      <div className="page-heading">
        <h1>项目设置</h1>
      </div>
      <div className="settings-content">
        <div className="settings-group settings-identity">
          <Section title="作品信息">
            <Field label="作品名称">
              <input
                value={p.title}
                onChange={(e) =>
                  commit((p) => {
                    p.title = e.target.value;
                  }, 'project-title')
                }
              />
            </Field>
            <Field label="作品简介">
              <textarea
                rows={4}
                value={p.description}
                onChange={(e) =>
                  commit((p) => {
                    p.description = e.target.value;
                  }, 'project-description')
                }
              />
            </Field>
            <Field label="作者">
              <input
                value={p.settings.author}
                placeholder="你的名字 / 工作室"
                onChange={(e) =>
                  commit((p) => {
                    p.settings.author = e.target.value;
                  }, 'author')
                }
              />
            </Field>
          </Section>
        </div>
        <div className="settings-group settings-authoring">
          <Section title="创作默认值">
            <CreativeOptionsForm options={editing?.options ?? defaults} change={editDefaults} />
            <div className="creative-pills project-creative-actions">
              <Button
                onClick={() => editDefaults({})}
                disabled={!editing && !Object.keys(defaults).length}
              >
                清空创作默认值
              </Button>
              {editing && <Button onClick={() => setDraft(undefined)}>取消编辑</Button>}
              <Button variant="primary" disabled={!editing} onClick={saveDefaults}>
                保存创作默认值
              </Button>
            </div>
            <div className="project-creative-list settings-visual-defaults">
              <Field label="画面比例">
                <select
                  value={aspect ?? ''}
                  onChange={(e) => {
                    const preset =
                      projectAspectPresets[e.target.value as keyof typeof projectAspectPresets];
                    if (!preset) return;
                    commit((p) => {
                      p.settings.width = preset.width;
                      p.settings.height = preset.height;
                    });
                  }}
                >
                  {!aspect && (
                    <option value="" hidden disabled>
                      旧画幅 · {p.settings.width} × {p.settings.height}
                    </option>
                  )}
                  {Object.entries(projectAspectPresets).map(([value, preset]) => (
                    <option key={value} value={value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="作品画风">
                <select
                  value={savedReference ?? savedPreset ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    const reference = creativeVisualStyleSchema.safeParse(value);
                    const preset = artStyleSchema.shape.preset.safeParse(value);
                    commit((draft) => {
                      updateCreativeDefaults(draft.settings, {
                        visualStyle: reference.data ?? null,
                      });
                      if (reference.success) return;
                      const description = draft.settings.artStyle?.description;
                      if (preset.success)
                        draft.settings.artStyle = { preset: preset.data, description };
                      else if (description)
                        draft.settings.artStyle = { preset: 'custom', description };
                      else delete draft.settings.artStyle;
                    });
                  }}
                >
                  <option value="">未设置</option>
                  <optgroup label="基础画风">
                    {!selectablePreset.success && savedPreset && (
                      <option value={savedPreset}>{artStylePresets[savedPreset].label}</option>
                    )}
                    {artStylePresetSchema.options.map((value) => (
                      <option key={value} value={value}>
                        {artStylePresets[value].label}
                      </option>
                    ))}
                  </optgroup>
                  {legacyReference && <option>{savedReference}</option>}
                  {Object.entries(creativeStyleGroups).map(([group, values]) => (
                    <optgroup key={group} label={group}>
                      {values.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <Field label="风格补充描述">
                <textarea
                  rows={3}
                  maxLength={atmosphereToneMaxLength}
                  placeholder="补充配色、光线、材质或线条等细节"
                  value={p.settings.atmosphereTone ?? ''}
                  onChange={(e) => {
                    const tone = e.target.value;
                    commit((draft) => {
                      if (tone) draft.settings.atmosphereTone = tone;
                      else delete draft.settings.atmosphereTone;
                    }, 'project-atmosphere-tone');
                  }}
                />
              </Field>
            </div>
          </Section>
        </div>
        <div className="settings-group settings-details">
          <Section title="工程信息">
            <dl className="project-details">
              <div>
                <dt>工程 ID</dt>
                <dd>
                  <code>{p.id}</code>
                </dd>
              </div>
              <div>
                <dt>运行环境</dt>
                <dd>{isDesktop ? 'Windows 桌面' : '浏览器预览'}</dd>
              </div>
              <div>
                <dt>素材管理</dt>
                <dd>本地复制 / 相对路径引用</dd>
              </div>
              <div>
                <dt>工程格式</dt>
                <dd>FrameForge Schema {p.formatVersion}</dd>
              </div>
            </dl>
          </Section>
        </div>
      </div>
    </main>
  );
}
