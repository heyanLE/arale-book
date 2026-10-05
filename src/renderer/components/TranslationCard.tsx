import { useState } from 'react';
import { BUILTIN_BING_PROFILE_ID } from '@shared/types';
import type {
  TranslationProfile,
  TranslationProviderId,
  TranslationSettings,
} from '@shared/types';

export interface TranslationCardProps {
  settings: TranslationSettings | null;
  loading: boolean;
  onReload: () => void;
  onUpdate: (patch: {
    profiles?: TranslationProfile[];
    activeProfileId?: string | null;
    targetLanguage?: TranslationSettings['targetLanguage'];
  }) => Promise<TranslationSettings | null>;
  onSetSecret: (profileId: string, secret: string | null) => Promise<TranslationSettings | null>;
}

const PROVIDERS: Array<{
  id: TranslationProviderId;
  label: string;
  applyUrl: string;
  applyLabel: string;
}> = [
  {
    id: 'bing',
    label: 'Bing 网页翻译',
    applyUrl: 'https://github.com/plainheart/bing-translate-api',
    applyLabel: '无需 Key · 查看说明',
  },
  {
    id: 'microsoft',
    label: 'Microsoft Translator',
    applyUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation',
    applyLabel: '创建 Translator 资源',
  },
  {
    id: 'deepl',
    label: 'DeepL',
    applyUrl: 'https://www.deepl.com/en/signup?cta=checkout&is_api=true&productId=api-developer',
    applyLabel: '申请 DeepL API Key',
  },
  {
    id: 'google',
    label: 'Google Cloud Translation',
    applyUrl: 'https://console.cloud.google.com/apis/library/translate.googleapis.com',
    applyLabel: '启用 Cloud Translation API',
  },
  {
    id: 'baidu',
    label: '百度翻译',
    applyUrl: 'https://fanyi-api.baidu.com/product/11',
    applyLabel: '申请百度翻译 API',
  },
  {
    id: 'libretranslate',
    label: 'LibreTranslate',
    applyUrl: 'https://portal.libretranslate.com/',
    applyLabel: '获取 Key / 自建服务',
  },
];

function newProfile(): TranslationProfile {
  return {
    id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    provider: 'microsoft',
    baseUrl: '',
    region: '',
    appId: '',
    hasSecret: false,
  };
}

export function TranslationCard(props: TranslationCardProps): JSX.Element {
  const { settings, loading, onReload, onUpdate, onSetSecret } = props;
  const [draft, setDraft] = useState<TranslationProfile[] | null>(null);
  const [newDraft, setNewDraft] = useState<TranslationProfile | null>(null);
  const [newError, setNewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});

  const profiles = draft ?? settings?.profiles ?? [];
  const persistedIds = new Set(settings?.profiles.map((profile) => profile.id) ?? []);
  const edit = (id: string, patch: Partial<TranslationProfile>) =>
    setDraft(profiles.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const saveChanges = async () => {
    if (draft === null) return;
    setSaving(true);
    const saved = await onUpdate({ profiles: draft });
    setSaving(false);
    if (saved) setDraft(null);
  };

  const saveNew = async () => {
    if (!newDraft) return;
    if (draft !== null) { setNewError('请先保存已有配置的修改。'); return; }
    if (!newDraft.name.trim()) { setNewError('请先填写配置名称。'); return; }
    setSaving(true);
    const saved = await onUpdate({ profiles: [...(settings?.profiles ?? []), newDraft] });
    setSaving(false);
    if (saved?.profiles.some((item) => item.id === newDraft.id)) { setNewDraft(null); setNewError(''); }
  };

  const removeProfile = async (profile: TranslationProfile) => {
    if (profile.id === BUILTIN_BING_PROFILE_ID || !window.confirm(`删除翻译配置「${profile.name}」？`)) return;
    if (draft !== null) { setNewError('请先保存已有配置的修改。'); return; }
    const remaining = (settings?.profiles ?? []).filter((item) => item.id !== profile.id);
    setSaving(true);
    const saved = await onUpdate({ profiles: remaining, ...(settings?.activeProfileId === profile.id ? { activeProfileId: BUILTIN_BING_PROFILE_ID } : {}) });
    setSaving(false);
    if (saved) setSecretDrafts((current) => { const copy = { ...current }; delete copy[profile.id]; return copy; });
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">翻译引擎</h2>
        <div className="settings-card-actions">
          <button type="button" className="btn btn-sm" disabled={newDraft !== null || draft !== null} onClick={() => { setNewDraft(newProfile()); setNewError(''); }}>
            新建配置
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={draft === null || saving}
            onClick={() => void saveChanges()}
          >
            {draft === null ? '已保存' : '保存 *'}
          </button>
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => { setDraft(null); onReload(); }}>
            重新读取
          </button>
        </div>
      </div>

      {newDraft && <div className="settings-row settings-row-block profile-new" aria-label="新建翻译配置"><div className="settings-row-main">
        <span className="settings-row-title">新配置 · 尚未保存</span>
        <div className="llm-grid">
          <label className="field"><span className="field-label">名称</span><input className="input" autoFocus value={newDraft.name} onChange={(event) => setNewDraft({ ...newDraft, name: event.target.value })} placeholder="如：我的 DeepL" /></label>
          <label className="field"><span className="field-label">提供商</span><select className="select" value={newDraft.provider} onChange={(event) => setNewDraft({ ...newDraft, provider: event.target.value as TranslationProviderId })}>{PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="field llm-grid-wide"><span className="field-label">服务地址（可选）</span><input className="input mono" value={newDraft.baseUrl} onChange={(event) => setNewDraft({ ...newDraft, baseUrl: event.target.value })} placeholder="留空使用官方地址" /></label>
        </div>
        {newError && <span className="settings-warn" role="alert">{newError}</span>}
        <div className="ext-actions llm-actions"><button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void saveNew()}>保存新配置</button><button type="button" className="btn btn-sm" onClick={() => { setNewDraft(null); setNewError(''); }}>取消</button></div>
      </div></div>}

      <div className="settings-row">
        <span className="settings-label">目标语言</span>
        <select
          className="select"
          value={settings?.targetLanguage ?? 'zh-Hans'}
          onChange={(event) => void onUpdate({ targetLanguage: event.target.value as TranslationSettings['targetLanguage'] })}
        >
          <option value="zh-Hans">简体中文</option>
          <option value="zh-Hant">繁體中文</option>
          <option value="en">English</option>
        </select>
      </div>

      <div className="settings-list">
        {profiles.map((profile) => {
          const builtin = profile.id === BUILTIN_BING_PROFILE_ID;
          if (builtin) return <div className="profile-builtin" key={profile.id}>
            <div><strong>Bing 网页翻译</strong><span>内置 · 免 Key · 中文译文＋原文罗马音（可能缺失）</span></div>
          </div>;
          const provider = PROVIDERS.find((item) => item.id === profile.provider)!;
          return (
          <div className="settings-row settings-row-block" key={profile.id}>
            <div className="settings-row-main">
              <div className="llm-grid">
                <div className="field">
                  <span className="field-label">名称</span>
                  <span className="input profile-identity" title="配置名称仅可在新建时填写">{profile.name}</span>
                </div>
                <div className="field">
                  <span className="field-label">提供商</span>
                  <span className="input profile-identity" title="提供商仅可在新建时选择">{provider.label}</span>
                  <small>当前适配器返回译文{profile.capabilities?.sourceReading === 'romaji' ? '和输入原文罗马音（可能缺失）' : '；未接入原文读音'}</small>
                </div>

                {profile.provider === 'microsoft' && (
                  <label className="field">
                    <span className="field-label">Region</span>
                    <input className="input mono" placeholder="可选，如 eastasia" value={profile.region} onChange={(event) => edit(profile.id, { region: event.target.value })} />
                  </label>
                )}
                {profile.provider === 'baidu' && (
                  <label className="field">
                    <span className="field-label">App ID</span>
                    <input className="input mono" value={profile.appId} onChange={(event) => edit(profile.id, { appId: event.target.value })} />
                  </label>
                )}

                {profile.provider === 'bing' ? (
                  <div className="detail-hint llm-grid-wide">
                    无需账号或 Key。请求由应用直接发送到 Bing 网页翻译服务。
                  </div>
                ) : (
                  <>
                    <label className="field llm-grid-wide">
                      <span className="field-label">自定义地址</span>
                      <input
                        className="input mono"
                        placeholder={profile.provider === 'libretranslate' ? 'http://127.0.0.1:5000' : '留空使用官方地址'}
                        value={profile.baseUrl}
                        onChange={(event) => edit(profile.id, { baseUrl: event.target.value })}
                      />
                    </label>
                    <label className="field llm-grid-wide">
                      <span className="field-label">{profile.provider === 'baidu' ? 'Secret Key' : 'API key'}</span>
                      <input
                        className="input mono"
                        type="password"
                        disabled={!persistedIds.has(profile.id)}
                        placeholder={!persistedIds.has(profile.id) ? '先保存配置，再填写密钥' : profile.hasSecret ? '已保存（留空表示不改）' : profile.provider === 'libretranslate' ? '自建服务通常可留空' : '必填'}
                        value={secretDrafts[profile.id] ?? ''}
                        onChange={(event) => setSecretDrafts((prev) => ({ ...prev, [profile.id]: event.target.value }))}
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="ext-actions llm-actions">
                <a
                  className="btn btn-sm"
                  href={provider.applyUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`在系统浏览器中打开：${provider.applyLabel}`}
                >
                  {provider.applyLabel} ↗
                </a>
                {profile.provider !== 'bing' && <button type="button" className="btn btn-sm" disabled={!secretDrafts[profile.id] || saving} onClick={() => void (async () => {
                  const saved = await onSetSecret(profile.id, secretDrafts[profile.id] ?? '');
                  if (saved) setSecretDrafts((current) => ({ ...current, [profile.id]: '' }));
                })()}>保存密钥</button>}
                {profile.hasSecret && <button type="button" className="btn btn-sm" onClick={() => void onSetSecret(profile.id, null)}>清除密钥</button>}
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={saving || draft !== null}
                  onClick={() => void removeProfile(profile)}
                >删除</button>
              </div>
            </div>
          </div>
          );
        })}
        <p className="settings-hint">名称与提供商在新建时确定。词卡默认翻译配置在“词卡弹窗”板块设置。</p>
      </div>
    </section>
  );
}
