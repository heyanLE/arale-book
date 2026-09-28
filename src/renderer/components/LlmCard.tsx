/**
 * 「LLM」设置卡片：管理 chat completions 兼容的服务。词卡默认值与提示词在词卡弹窗卡片中。
 *
 * ## 为什么是**手动保存**
 *
 * 第一版是每敲一个字就 `onUpdate({profiles})` 写盘。结果是**根本没法输入**：
 * 每次按键都把整个 profiles 数组送出去，主进程写盘后把规范化过的结果回给渲染进程，
 * 输入框的 value 被服务端版本覆盖 —— 光标跳位、刚敲的字消失。
 * 现在输入只改本地草稿，点「保存」才落盘；有未保存改动时按钮高亮，离开也能看出状态。
 *
 * ## 为什么是多套配置
 *
 * 一个用户很可能同时有「本地跑的小模型」和「云端的大模型」：随手查词用本地的
 * （快、免费、离线），拿不准的词用云端的。只允许一套会逼着他每次改地址。
 * 词卡上还能**临时指定**用哪一套（见 `WordCardPopup` 的 LLM 栏）。
 *
 * ## API key 只进不出
 *
 * 主进程从不把 key 返回渲染进程，这里只显示「已保存 / 未保存」。所以输入框永远是空的，
 * 占位符说明「留空表示不改」，清空要用专门的按钮——否则用户没法表达「我要删掉它」。
 */

import { useState } from 'react';
import type { LlmProfile, LlmProfileInput, LlmSettings } from '@shared/types';

export interface LlmCardProps {
  settings: LlmSettings | null;
  loading: boolean;
  onReload: () => void;
  onUpdate: (patch: {
    profiles?: LlmProfileInput[];
    activeProfileId?: string | null;
    prompt?: string;
  }) => Promise<LlmSettings | null>;
}

/** 新配置的初始值：指向本机最常见的本地服务，用户改地址比从空白填快。 */
const NEW_PROFILE: Omit<LlmProfile, 'id'> = {
  name: '新配置',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: '',
  temperature: 0.3,
  hasApiKey: false,
};

export function LlmCard(props: LlmCardProps): JSX.Element {
  const { settings, loading, onReload, onUpdate } = props;

  /**
   * 本地草稿。`null` = 没有未保存的改动，界面直接显示服务端值。
   *
   * 存整份 profiles 而不是「按字段 diff」：用户可能一次改好几个字段再保存，
   * diff 只会让「保存」的语义变模糊（保存了什么？）。
   */
  const [draft, setDraft] = useState<LlmProfile[] | null>(null);
  const [newDraft, setNewDraft] = useState<LlmProfile | null>(null);
  const [newKeyDraft, setNewKeyDraft] = useState('');
  const [newError, setNewError] = useState('');
  const [saving, setSaving] = useState(false);
  /** undefined = 保留密钥，字符串 = 替换，null = 保存时清除。 */
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string | null>>({});

  const profiles = draft ?? settings?.profiles ?? [];
  const activeId = settings?.activeProfileId ?? null;
  const dirty = draft !== null || Object.keys(keyDrafts).length > 0;

  const editProfile = (id: string, patch: Partial<LlmProfile>) => {
    setDraft(profiles.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const commit = async () => {
    if (!dirty) return;
    setSaving(true);
    const saved = await onUpdate({
      profiles: (draft ?? profiles).map((profile): LlmProfileInput =>
        Object.prototype.hasOwnProperty.call(keyDrafts, profile.id)
          ? { ...profile, apiKey: keyDrafts[profile.id] }
          : profile,
      ),
    });
    setSaving(false);
    if (saved) { setDraft(null); setKeyDrafts({}); }
  };

  const addProfile = () => {
    setNewError('');
    setNewKeyDraft('');
    setNewDraft({ ...NEW_PROFILE, name: '', id: `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` });
  };

  const saveNew = async () => {
    if (!newDraft) return;
    if (dirty) { setNewError('请先保存已有配置的修改。'); return; }
    if (!newDraft.name.trim() || !newDraft.baseUrl.trim() || !newDraft.model.trim()) {
      setNewError('请填写名称、服务地址和模型。API Key 可留空。');
      return;
    }
    setSaving(true);
    const saved = await onUpdate({ profiles: [...(settings?.profiles ?? []), { ...newDraft, apiKey: newKeyDraft.trim() }] });
    if (saved?.profiles.some((profile) => profile.id === newDraft.id)) {
      setNewError('');
      setNewDraft(null);
      setNewKeyDraft('');
      setDraft(null);
    }
    setSaving(false);
  };

  const removeProfile = async (id: string) => {
    if (dirty) return;
    if (!window.confirm('删除这套 LLM 配置？')) return;
    const next = (settings?.profiles ?? []).filter((item) => item.id !== id);
    setSaving(true);
    const saved = await onUpdate({ profiles: next, ...(activeId === id ? { activeProfileId: next[0]?.id ?? null } : {}) });
    setSaving(false);
    if (saved) setDraft(null);
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">LLM 配置</h2>
        <div className="settings-card-actions">
          <button type="button" className="btn btn-sm" disabled={newDraft !== null || dirty} onClick={addProfile}>
            新建配置
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void commit()}
            disabled={!dirty || saving}
            title={dirty ? '把改动写入磁盘' : '没有未保存的改动'}
          >
            {dirty ? '保存 *' : '已保存'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => { setDraft(null); setKeyDrafts({}); onReload(); }} disabled={loading}>
            重新读取
          </button>
        </div>
      </div>

      {newError && <div className="settings-note settings-warn" role="alert">{newError}</div>}

      {newDraft && <div className="settings-row settings-row-block profile-new" aria-label="新建 LLM 配置">
        <div className="settings-row-main">
          <span className="settings-row-title">新配置 · 尚未保存</span>
          <div className="llm-grid">
            <label className="field"><span className="field-label">名称</span><input className="input" autoFocus value={newDraft.name} onChange={(event) => setNewDraft({ ...newDraft, name: event.target.value })} placeholder="例如：本地 Qwen" /></label>
            <label className="field llm-grid-wide"><span className="field-label">服务地址</span><input className="input mono" value={newDraft.baseUrl} onChange={(event) => setNewDraft({ ...newDraft, baseUrl: event.target.value })} /></label>
            <label className="field"><span className="field-label">模型</span><input className="input" value={newDraft.model} onChange={(event) => setNewDraft({ ...newDraft, model: event.target.value })} placeholder="例如：qwen2.5:7b" /></label>
            <label className="field"><span className="field-label">温度</span><input className="input" type="number" min="0" max="2" step="0.1" value={newDraft.temperature} onChange={(event) => setNewDraft({ ...newDraft, temperature: Number(event.target.value) })} /></label>
            <label className="field llm-grid-wide"><span className="field-label">API Key（可选，本地模型可留空）</span><input className="input mono" type="password" autoComplete="off" value={newKeyDraft} onChange={(event) => setNewKeyDraft(event.target.value)} placeholder="可在新建时填写，也可保存后补充" /></label>
          </div>
          <div className="ext-actions llm-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void saveNew()}>保存新配置</button>
            <button type="button" className="btn btn-sm" onClick={() => { setNewDraft(null); setNewKeyDraft(''); setNewError(''); }}>取消</button>
          </div>
        </div>
      </div>}

      <div className="settings-list">
        {profiles.map((profile) => (
          <div className="settings-row settings-row-block" key={profile.id}>
            <div className="settings-row-main">
              <div className="llm-grid">
                <div className="field">
                  <span className="field-label">名称</span>
                  <span className="input profile-identity" title="配置名称仅可在新建时填写">{profile.name}</span>
                </div>
                <label className="field">
                  <span className="field-label">模型</span>
                  <input
                    className="input"
                    placeholder="gpt-4o-mini / qwen2.5:7b …"
                    value={profile.model}
                    onChange={(e) => editProfile(profile.id, { model: e.target.value })}
                  />
                </label>
                <label className="field llm-grid-wide">
                  <span className="field-label">地址</span>
                  <input
                    className="input mono"
                    placeholder="https://api.example.com/v1"
                    value={profile.baseUrl}
                    onChange={(e) => editProfile(profile.id, { baseUrl: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">温度</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={String(profile.temperature)}
                    onChange={(e) => {
                      const value = Number.parseFloat(e.target.value);
                      editProfile(profile.id, { temperature: Number.isFinite(value) ? value : 0.3 });
                    }}
                  />
                </label>
                <label className="field llm-grid-wide">
                  <span className="field-label">API key</span>
                  <input
                    className="input mono"
                    type="password"
                    // 永远不回显已存的 key（主进程不返回它），所以这里只表达「要改成什么」。
                    placeholder={keyDrafts[profile.id] === null ? '保存配置时清除 Key' : profile.hasApiKey ? '已保存（留空表示不改）' : '本地服务通常不用填'}
                    value={keyDrafts[profile.id] ?? ''}
                    onChange={(e) => setKeyDrafts((prev) => {
                      const next = { ...prev };
                      if (e.target.value === '') delete next[profile.id];
                      else next[profile.id] = e.target.value;
                      return next;
                    })}
                  />
                </label>
              </div>

              <div className="ext-actions llm-actions">
                {profile.hasApiKey && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setKeyDrafts((current) => ({ ...current, [profile.id]: null }))}
                    title="标记清除；点击上方保存配置后生效"
                  >
                    {keyDrafts[profile.id] === null ? '待清除 Key' : '清除 Key'}
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-danger" disabled={dirty || saving} title={dirty ? '先保存或放弃未保存修改' : '删除配置'} onClick={() => void removeProfile(profile.id)}>
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}

        {profiles.length === 0 && (
          <div className="detail-hint">
            还没有配置。点「新建配置」填写名称、地址、模型、温度和可选 Key，一次保存。
          </div>
        )}
      </div>

      <p className="settings-hint">默认模型与分析提示词在“词卡弹窗”板块中设置。</p>
    </section>
  );
}
