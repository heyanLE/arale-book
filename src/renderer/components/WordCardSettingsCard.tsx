/** 词卡弹窗的使用偏好。配置的创建与编辑分别留在 LLM / 翻译卡片中。 */
import { useState } from 'react';
import type { LlmSettings, TranslationSettings } from '@shared/types';

export interface WordCardSettingsCardProps {
  llm: {
    settings: LlmSettings | null;
    onUpdate: (patch: { activeProfileId?: string | null; prompt?: string }) => Promise<LlmSettings | null>;
  } | null;
  translation: {
    settings: TranslationSettings | null;
    onUpdate: (patch: { activeProfileId?: string | null }) => Promise<TranslationSettings | null>;
  } | null;
}

export function WordCardSettingsCard({ llm, translation }: WordCardSettingsCardProps): JSX.Element {
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const llmSettings = llm?.settings ?? null;
  const translationSettings = translation?.settings ?? null;

  async function savePrompt(): Promise<void> {
    if (!llm || promptDraft === null) return;
    setSavingPrompt(true);
    const saved = await llm.onUpdate({ prompt: promptDraft });
    setSavingPrompt(false);
    if (saved) setPromptDraft(null);
  }

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">词卡弹窗</h2>
      </div>
      <p className="settings-hint">这里决定词卡首次打开时的配置；每张词卡仍可临时选择其他引擎。</p>

      <div className="wordcard-settings-section">
        <h3>翻译栏配置</h3>
        <div className="settings-row">
          <span className="settings-label">默认翻译引擎</span>
          <select
            className="select settings-select-wide"
            value={translationSettings?.activeProfileId ?? ''}
            disabled={!translationSettings}
            onChange={(event) => { if (translation) void translation.onUpdate({ activeProfileId: event.target.value || null }); }}
          >
            {(translationSettings?.profiles ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="wordcard-settings-section">
        <h3>LLM 分析栏配置</h3>
        <div className="settings-row">
          <span className="settings-label">默认 LLM 配置</span>
          <select
            className="select settings-select-wide"
            value={llmSettings?.activeProfileId ?? ''}
            disabled={!llmSettings}
            onChange={(event) => { if (llm) void llm.onUpdate({ activeProfileId: event.target.value || null }); }}
          >
            <option value="">不预选 LLM</option>
            {(llmSettings?.profiles ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}{profile.model ? ' · ' + profile.model : ' · 待设置模型'}</option>
            ))}
          </select>
        </div>

        <div className="settings-row settings-row-block">
          <div className="settings-row-main">
            <span className="settings-row-title">分析提示词</span>
            <textarea
              className="input mono llm-prompt"
              rows={8}
              value={promptDraft ?? llmSettings?.prompt ?? ''}
              disabled={!llmSettings}
              onChange={(event) => setPromptDraft(event.target.value)}
            />
            <span className="settings-row-sub">{'{{word}}'} 表示词，{'{{context}}'} 表示查词时的上下文。</span>
            <div className="ext-actions llm-actions">
              <button type="button" className="btn btn-sm btn-primary" disabled={promptDraft === null || savingPrompt} onClick={() => void savePrompt()}>
                {savingPrompt ? '保存中…' : '保存提示词'}
              </button>
              {promptDraft !== null && <button type="button" className="btn btn-sm" onClick={() => setPromptDraft(null)}>放弃修改</button>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
