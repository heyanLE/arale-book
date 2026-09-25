/**
 * 「LLM」设置卡片：配置 chat completions 兼容的服务，以及分析用的提示词。
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

import { useEffect, useState } from 'react';
import type { LlmProfile, LlmSettings } from '@shared/types';

export interface LlmCardProps {
  settings: LlmSettings | null;
  loading: boolean;
  onReload: () => void;
  onUpdate: (patch: {
    profiles?: LlmProfile[];
    activeProfileId?: string | null;
    prompt?: string;
  }) => void;
  onSetApiKey: (profileId: string, apiKey: string | null) => void;
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
  const { settings, loading, onReload, onUpdate, onSetApiKey } = props;

  /**
   * 本地草稿。`null` = 没有未保存的改动，界面直接显示服务端值。
   *
   * 存整份 profiles 而不是「按字段 diff」：用户可能一次改好几个字段再保存，
   * diff 只会让「保存」的语义变模糊（保存了什么？）。
   */
  const [draft, setDraft] = useState<LlmProfile[] | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});

  // 服务端值变了（保存成功、重新读取）就丢掉草稿，避免界面和磁盘长期不一致。
  useEffect(() => {
    setDraft(null);
  }, [settings]);

  const profiles = draft ?? settings?.profiles ?? [];
  const activeId = settings?.activeProfileId ?? null;
  const dirty = draft !== null || promptDraft !== null;

  const editProfile = (id: string, patch: Partial<LlmProfile>) => {
    setDraft(profiles.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const commit = () => {
    if (promptDraft !== null) onUpdate({ prompt: promptDraft });
    if (draft !== null) onUpdate({ profiles: draft });
    setDraft(null);
    setPromptDraft(null);
  };

  const addProfile = () => {
    const id = `llm_${Date.now().toString(36)}`;
    setDraft([...profiles, { ...NEW_PROFILE, id }]);
  };

  const removeProfile = (id: string) => {
    const next = profiles.filter((item) => item.id !== id);
    setDraft(next);
    // 删掉的如果是当前默认，顺手把默认挪到第一套——否则会留一个悬空 id。
    if (activeId === id) onUpdate({ activeProfileId: next[0]?.id ?? null });
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">LLM 配置</h2>
        <div className="settings-card-actions">
          <button type="button" className="btn btn-sm" onClick={addProfile}>
            新增
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={commit}
            disabled={!dirty}
            title={dirty ? '把改动写入磁盘' : '没有未保存的改动'}
          >
            {dirty ? '保存 *' : '已保存'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onReload} disabled={loading}>
            重新读取
          </button>
        </div>
      </div>

      <div className="settings-list">
        {profiles.map((profile) => (
          <div className="settings-row settings-row-block" key={profile.id}>
            <div className="settings-row-main">
              <div className="llm-grid">
                <label className="field">
                  <span className="field-label">名称</span>
                  <input
                    className="input"
                    value={profile.name}
                    onChange={(e) => editProfile(profile.id, { name: e.target.value })}
                  />
                </label>
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
                    placeholder={profile.hasApiKey ? '已保存（留空表示不改）' : '本地服务通常不用填'}
                    value={keyDrafts[profile.id] ?? ''}
                    onChange={(e) => setKeyDrafts((prev) => ({ ...prev, [profile.id]: e.target.value }))}
                    onBlur={() => {
                      const value = keyDrafts[profile.id];
                      if (value === undefined || value === '') return;
                      onSetApiKey(profile.id, value);
                      setKeyDrafts((prev) => ({ ...prev, [profile.id]: '' }));
                    }}
                  />
                </label>
              </div>

              <div className="ext-actions llm-actions">
                <label className="check" title="词卡上没指定时默认用这一套">
                  <input
                    type="radio"
                    name="llm-active"
                    checked={activeId === profile.id}
                    onChange={() => onUpdate({ activeProfileId: profile.id })}
                  />
                  <span>默认</span>
                </label>
                {profile.hasApiKey && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onSetApiKey(profile.id, null)}
                    title="删掉已保存的 API key"
                  >
                    清除 key
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-danger" onClick={() => removeProfile(profile.id)}>
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}

        {profiles.length === 0 && (
          <div className="detail-hint">
            还没有配置。点「新增」加一套（本地 llama.cpp / Ollama / LM Studio 与各家云端都支持）。
          </div>
        )}
      </div>

      <div className="settings-row settings-row-block">
        <div className="settings-row-main">
          <span className="settings-row-title">分析提示词</span>
          <textarea
            className="input mono llm-prompt"
            rows={8}
            value={promptDraft ?? settings?.prompt ?? ''}
            onChange={(e) => setPromptDraft(e.target.value)}
          />
          <span className="settings-row-sub">
            <code>{'{{word}}'}</code> 替换成词，<code>{'{{context}}'}</code> 替换成查词时的上下文。
            {promptDraft !== null && promptDraft !== settings?.prompt && (
              <b className="settings-warn"> · 有未保存的改动，点上面的「保存」</b>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}
