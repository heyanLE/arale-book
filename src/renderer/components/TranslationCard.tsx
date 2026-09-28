import { useEffect, useState } from 'react';
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
  }) => void;
  onSetSecret: (profileId: string, secret: string | null) => void;
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
    id: `tr_${Date.now().toString(36)}`,
    name: 'Microsoft Translator',
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
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  useEffect(() => setDraft(null), [settings]);

  const profiles = draft ?? settings?.profiles ?? [];
  const persistedIds = new Set(settings?.profiles.map((profile) => profile.id) ?? []);
  const activeId = settings?.activeProfileId ?? null;
  const edit = (id: string, patch: Partial<TranslationProfile>) =>
    setDraft(profiles.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">翻译引擎</h2>
        <div className="settings-card-actions">
          <button type="button" className="btn btn-sm" onClick={() => setDraft([...profiles, newProfile()])}>
            新增
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={draft === null}
            onClick={() => { if (draft !== null) onUpdate({ profiles: draft }); setDraft(null); }}
          >
            {draft === null ? '已保存' : '保存 *'}
          </button>
          <button type="button" className="btn btn-sm" disabled={loading} onClick={onReload}>
            重新读取
          </button>
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">目标语言</span>
        <select
          className="select"
          value={settings?.targetLanguage ?? 'zh-Hans'}
          onChange={(event) => onUpdate({ targetLanguage: event.target.value as TranslationSettings['targetLanguage'] })}
        >
          <option value="zh-Hans">简体中文</option>
          <option value="zh-Hant">繁體中文</option>
          <option value="en">English</option>
        </select>
      </div>

      <div className="settings-list">
        {profiles.map((profile) => {
          const provider = PROVIDERS.find((item) => item.id === profile.provider)!;
          return (
          <div className="settings-row settings-row-block" key={profile.id}>
            <div className="settings-row-main">
              <div className="llm-grid">
                <label className="field">
                  <span className="field-label">名称</span>
                  <input className="input" value={profile.name} onChange={(event) => edit(profile.id, { name: event.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">提供商</span>
                  <select
                    className="select"
                    value={profile.provider}
                    onChange={(event) => {
                      const provider = event.target.value as TranslationProviderId;
                      edit(profile.id, { provider, name: PROVIDERS.find((item) => item.id === provider)?.label ?? profile.name });
                    }}
                  >
                    {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>

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
                        onBlur={() => {
                          const value = secretDrafts[profile.id];
                          if (!value) return;
                          onSetSecret(profile.id, value);
                          setSecretDrafts((prev) => ({ ...prev, [profile.id]: '' }));
                        }}
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
                <label className="check" title="词卡上没指定时默认使用这一套">
                  <input type="radio" name="translation-active" checked={activeId === profile.id} onChange={() => onUpdate({ activeProfileId: profile.id })} />
                  <span>默认</span>
                </label>
                {profile.hasSecret && <button type="button" className="btn btn-sm" onClick={() => onSetSecret(profile.id, null)}>清除密钥</button>}
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    const next = profiles.filter((item) => item.id !== profile.id);
                    setDraft(next);
                    if (activeId === profile.id) onUpdate({ activeProfileId: next[0]?.id ?? null });
                  }}
                >删除</button>
              </div>
            </div>
          </div>
          );
        })}
        {profiles.length === 0 && <div className="detail-hint">还没有配置。新增一套并填写用户自己的 API key；LibreTranslate 自建服务可不填 key。</div>}
      </div>
    </section>
  );
}
