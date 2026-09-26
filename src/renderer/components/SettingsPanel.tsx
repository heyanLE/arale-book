/**
 * 设置面板：词典管理 + 阅读器默认值。
 *
 * 词典相关的三种动作（导入 / 启用停用 / 卸载）都由主进程返回**整份新的**
 * `DictionaryStatus`，所以这里不需要第二套本地模型，直接整体替换即可 —— 也顺带保证了
 * 「后台载入完成」的 `dict:changed` 事件与按钮操作走同一条更新路径。
 */

import { useCallback, useEffect, useState } from 'react';
import type { DictionaryStatus, LibraryInfo, OcrCapability, OcrProviderId } from '@shared/types';
import type { ExtensionProgress, ExtensionStatus, OcrRepository } from '@shared/extensions';
import type { LlmProfile, LlmSettings } from '@shared/types';
import type { AppDefaults } from '@shared/defaults';
import { SPREAD_OFFSETS, clampSpreadOffset, spreadOffsetLabel } from '@core/comic/spread';
import { ExtensionsCard } from './ExtensionsCard';
import { LlmCard } from './LlmCard';
import { api, call, reportApiError, useIpcEvent } from '../lib/api';
import {
  DEFAULT_SETTINGS,
  updateSettings,
  useSettings,
  type AppSettings,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  type ComicFitMode,
  type LibraryViewMode,
  type ThemeMode,
} from '../lib/reader-settings';

export interface SettingsPanelProps {
  info: LibraryInfo | null;
  onClose: () => void;
  onStatus: (message: string) => void;
  /** 各 OCR 引擎的可用性与就绪状态（App 启动时探过一次）。 */
  ocrCapability?: OcrCapability | null;
  onRefreshOcrCapability?: () => void;
  onSelectOcrProvider?: (provider: OcrProviderId) => void;
  defaults?: {
    value: AppDefaults;
    onChange: (patch: Partial<AppDefaults>) => void;
  };
  llm?: {
    settings: LlmSettings | null;
    loading: boolean;
    onReload: () => void;
    onUpdate: (patch: {
      profiles?: LlmProfile[];
      activeProfileId?: string | null;
      prompt?: string;
    }) => void;
    onSetApiKey: (profileId: string, apiKey: string | null) => void;
  };
  extensions?: {
    statuses: ExtensionStatus[];
    repositories: OcrRepository[];
    source: 'cache' | 'bundled' | 'none';
    error: string | null;
    progress: Record<string, ExtensionProgress>;
    loading: boolean;
    onRefresh: () => void;
    onInstall: (id: string) => void;
    onCancel: (id: string) => void;
    onRemove: (id: string) => void;
    onAddRepository: (name: string, url: string) => void;
    onRemoveRepository: (url: string) => void;
  };
}

export function SettingsPanel({
  info,
  onClose,
  onStatus,
  ocrCapability = null,
  onRefreshOcrCapability,
  onSelectOcrProvider,
  extensions,
  llm,
  defaults,
}: SettingsPanelProps): JSX.Element {
  const settings = useSettings();
  const [dict, setDict] = useState<DictionaryStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadDict = useCallback(async () => {
    setBusy(true);
    const status = await call('读取词典状态', () => api.dict.status());
    setBusy(false);
    if (status) setDict(status);
  }, []);

  useEffect(() => {
    void reloadDict();
  }, [reloadDict]);

  // 主进程在后台把 bank 索引进内存后会推这条事件，届时刷新计数与 loaded 标记。
  useIpcEvent('dict:changed', (status) => setDict(status));

  const importDictionary = useCallback(async () => {
    setBusy(true);
    const status = await call('导入词典', () => api.dict.importViaDialog());
    setBusy(false);
    // 取消对话框时返回 null，此时保留原状态，不要把它当成空状态覆盖进去。
    if (status) {
      setDict(status);
      onStatus(`已安装 ${status.dictionaries.length} 部词典`);
    }
  }, [onStatus]);

  const setEnabled = useCallback(
    async (dictId: string, enabled: boolean) => {
      setBusy(true);
      const status = await call('切换词典状态', () => api.dict.setEnabled(dictId, enabled));
      setBusy(false);
      if (status) setDict(status);
    },
    [],
  );

  const removeDictionary = useCallback(
    async (dictId: string, title: string) => {
      // 用 window.confirm：它是同步阻塞的原生弹窗，在 Electron 里语义正确、零依赖。
      // 缺点是不能定制文案样式；对「卸载词典」这种低频破坏性操作够用了。
      if (!window.confirm(`确定卸载词典「${title}」？\n\n词典文件会从词典目录中删除，此操作不可撤销。`)) {
        return;
      }
      setBusy(true);
      const status = await call('卸载词典', () => api.dict.remove(dictId));
      setBusy(false);
      if (status) {
        setDict(status);
        onStatus(`已卸载「${title}」`);
      }
    },
    [onStatus],
  );

  const copyDictDir = useCallback(async () => {
    if (!dict) return;
    try {
      await navigator.clipboard.writeText(dict.dir);
      onStatus('已复制词典目录路径');
    } catch (error) {
      reportApiError('复制路径', error);
    }
  }, [dict, onStatus]);

  const patch = useCallback((next: Partial<AppSettings>) => updateSettings(next), []);

  return (
    <div className="settings">
      <div className="settings-header">
        <span className="settings-title">设置</span>
        <div className="settings-header-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (window.confirm('恢复所有设置为默认值？')) {
                updateSettings({ ...DEFAULT_SETTINGS });
                onStatus('设置已恢复默认');
              }
            }}
          >
            恢复默认
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            返回书库
          </button>
        </div>
      </div>

      <div className="settings-body">
        {/* =====================================================================
            通用 —— 与载体无关的东西：书库位置、词典、界面外观。
            ===================================================================== */}
        <h2 className="settings-group">通用</h2>

        {/* ---------------- 书库 ---------------- */}
        <section className="settings-card">
          <div className="settings-card-head">
            <h2 className="settings-card-title">书库</h2>
          </div>
          <div className="settings-row">
            <span className="settings-label">书库目录</span>
            <span className="settings-value mono cell-ellipsis" title={info?.dir ?? ''}>
              {info?.dir ?? '（未连接主进程）'}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">藏书</span>
            <span className="settings-value">
              {info ? `共 ${info.bookCount} 本（EPUB ${info.epubCount} / 漫画 ${info.comicCount}）` : '读取中…'}
            </span>
          </div>
        </section>

        {/* ---------------- 词典 ---------------- */}
        <section className="settings-card">
          <div className="settings-card-head">
            <h2 className="settings-card-title">词典</h2>
            <div className="settings-card-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void importDictionary()}
                disabled={busy}
              >
                导入 Yomitan 词典…
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void reloadDict()} disabled={busy}>
                刷新
              </button>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">词典目录</span>
            <span className="settings-value mono cell-ellipsis" title={dict?.dir ?? ''}>
              {dict?.dir ?? '（未连接主进程）'}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void copyDictDir()} disabled={!dict}>
              复制
            </button>
          </div>

          <div className="settings-row">
            <span className="settings-label">索引状态</span>
            <span className="settings-value">
              {dict === null
                ? '读取中…'
                : `${dict.dictionaries.filter((d) => d.enabled).length} / ${dict.dictionaries.length} 部启用 · ${dict.termCount} 条词条 · ${
                    dict.loaded ? '已载入内存' : '未载入'
                  }`}
            </span>
          </div>

          {dict !== null && dict.dictionaries.length === 0 && (
            <p className="settings-hint">还没有安装词典。支持 Yomitan 格式的 zip（也可直接拖进窗口）。</p>
          )}

          {dict !== null && dict.dictionaries.length > 0 && (
            <ul className="dict-list">
              {dict.dictionaries.map((d) => (
                <li key={d.id} className={`dict-row${d.enabled ? '' : ' is-disabled'}`}>
                  <label className="dict-toggle" title={d.enabled ? '点击停用' : '点击启用'}>
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      disabled={busy}
                      onChange={(e) => void setEnabled(d.id, e.target.checked)}
                    />
                  </label>
                  <div className="dict-row-main">
                    <div className="dict-title cell-ellipsis" title={d.title}>
                      {d.title}
                    </div>
                    <div className="dict-meta mono">
                      {d.format} · {d.termCount} 条 · 频率 {d.freqCount} 条 · 导入于{' '}
                      {formatDate(d.importedAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => void removeDictionary(d.id, d.title)}
                  >
                    卸载
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------------- 外观与布局 ---------------- */}
        <section className="settings-card">
          <div className="settings-card-head">
            <h2 className="settings-card-title">外观与布局</h2>
          </div>

          <div className="settings-row">
            <span className="settings-label">主题</span>
            <select
              className="select"
              value={settings.theme}
              onChange={(e) => patch({ theme: e.target.value as ThemeMode })}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">默认列表模式</span>
            <select
              className="select"
              value={settings.libraryView}
              onChange={(e) => patch({ libraryView: e.target.value as LibraryViewMode })}
            >
              <option value="grid">封面网格</option>
              <option value="list">详细列表</option>
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">布局</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.showSidebar}
                onChange={(e) => patch({ showSidebar: e.target.checked })}
              />
              <span>显示左侧栏</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.showDetail}
                onChange={(e) => patch({ showDetail: e.target.checked })}
              />
              <span>显示右侧详情</span>
            </label>
          </div>

          <div className="settings-row">
            <span className="settings-label">沉浸模式</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.autoHideChrome}
                onChange={(e) => patch({ autoHideChrome: e.target.checked })}
              />
              <span>阅读时自动隐藏上下工具栏（鼠标一动就回来）</span>
            </label>
          </div>
        </section>

        {/* =====================================================================
            漫画 —— 只影响漫画：文字识别（可选）与漫画阅读器。
            ===================================================================== */}
        <h2 className="settings-group">漫画</h2>

        {/* ---------------- OCR 引擎（可选能力） ---------------- */}
        <section className="settings-card">
          <div className="settings-card-head">
            <h2 className="settings-card-title">文字识别（OCR）</h2>
            <div className="settings-card-actions">
              <button type="button" className="btn btn-sm" onClick={onRefreshOcrCapability}>
                重新探测
              </button>
            </div>
          </div>



          <div className="settings-list">
            {(ocrCapability?.providers ?? []).map((engine) => {
              const selected = ocrCapability?.selected === engine.id;
              return (
                <label
                  key={engine.id}
                  className={`settings-row${engine.available ? '' : ' is-disabled'}`}
                >
                  <input
                    type="radio"
                    name="ocr-provider"
                    checked={selected}
                    disabled={!engine.available}
                    onChange={() => onSelectOcrProvider?.(engine.id)}
                  />
                  <span className="settings-row-main">
                    <span className="settings-row-title">
                      {engine.label}
                      {selected && <span className="segment-chip">默认</span>}
                      {!engine.available && <span className="segment-chip">不可用</span>}
                      {engine.available && !engine.ready && (
                        <span className="segment-chip">
                          首次约 {engine.downloadSizeMb} MB
                        </span>
                      )}
                    </span>
                    <span className="settings-row-sub">
                      {engine.requirement}
                      {engine.reason ? ` · ${engine.reason}` : ''}
                    </span>
                  </span>
                </label>
              );
            })}
            {(ocrCapability?.providers ?? []).length === 0 && (
              <div className="detail-hint">正在探测可用引擎…</div>
            )}
          </div>

        </section>

        {/* ---------------- 漫画阅读器 ---------------- */}
        <section className="settings-card">
          <div className="settings-card-head">
            <h2 className="settings-card-title">漫画阅读器</h2>
          </div>

          <div className="settings-row">
            <span className="settings-label">新书默认方向</span>
            <select
              className="select settings-select-wide"
              value={defaults?.value.direction ?? 'rtl'}
              onChange={(e) => defaults?.onChange({ direction: e.target.value as 'ltr' | 'rtl' })}
              title="导入新书时用它；已经导入的书不受影响"
            >
              <option value="rtl">RTL 从右到左</option>
              <option value="ltr">LTR 从左到右</option>
            </select>
            <span className="settings-value">只影响以后导入的书</span>
          </div>

          <div className="settings-row">
            <span className="settings-label">页面适配</span>
            <select
              className="select"
              value={settings.comicFit}
              onChange={(e) => patch({ comicFit: e.target.value as ComicFitMode })}
            >
              <option value="height">适应高度</option>
              <option value="width">适应宽度</option>
              <option value="actual">原始尺寸</option>
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">双页跨页</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.comicSpread}
                onChange={(e) => patch({ comicSpread: e.target.checked })}
              />
              <span>并排显示两页（RTL 书从右往左排）</span>
            </label>
          </div>

          <div className="settings-row">
            <span className="settings-label">配对偏移</span>
            <select
              className="select settings-select-num"
              value={String(clampSpreadOffset(settings.comicSpreadOffset))}
              disabled={!settings.comicSpread}
              onChange={(e) => patch({ comicSpreadOffset: clampSpreadOffset(Number(e.target.value)) })}
            >
              {SPREAD_OFFSETS.map((value) => (
                <option key={value} value={String(value)}>
                  {value}
                </option>
              ))}
            </select>
            <span className="settings-value">{spreadOffsetLabel(settings.comicSpreadOffset)}</span>
          </div>

          <p className="settings-hint">
            偏移 N = 前 N 页单独成页，从第 N+1 页开始两两配对（只在双页时生效）。
          </p>
        </section>

        {/* =====================================================================
            LLM —— 词卡分析用。
            ===================================================================== */}
        <h2 className="settings-group">LLM</h2>

        {llm ? (
          <LlmCard
            settings={llm.settings}
            loading={llm.loading}
            onReload={llm.onReload}
            onUpdate={llm.onUpdate}
            onSetApiKey={llm.onSetApiKey}
          />
        ) : (
          <section className="settings-card">
            <div className="detail-hint">LLM 配置还没载入。</div>
          </section>
        )}

        {/* =====================================================================
            扩展 —— 可下载安装的能力包（现在只有 OCR 引擎）。
            ===================================================================== */}
        <h2 className="settings-group">扩展</h2>

        {extensions ? (
          <ExtensionsCard
            statuses={extensions.statuses}
            repositories={extensions.repositories}
            source={extensions.source}
            error={extensions.error}
            progress={extensions.progress}
            loading={extensions.loading}
            onRefresh={extensions.onRefresh}
            onInstall={extensions.onInstall}
            onCancel={extensions.onCancel}
            onRemove={extensions.onRemove}
            onAddRepository={extensions.onAddRepository}
            onRemoveRepository={extensions.onRemoveRepository}
          />
        ) : (
          <section className="settings-card">
            <div className="detail-hint">扩展信息还没载入。</div>
          </section>
        )}

        {/* =====================================================================
            小说 —— 只影响 EPUB 阅读器。
            ===================================================================== */}
        <h2 className="settings-group">小说</h2>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2 className="settings-card-title">小说阅读器</h2>
          </div>

          <div className="settings-row">
            <span className="settings-label">正文字号</span>
            <input
              className="range"
              type="range"
              min={FONT_SCALE_MIN}
              max={FONT_SCALE_MAX}
              step={0.05}
              value={settings.fontScale}
              onChange={(e) => patch({ fontScale: Number(e.target.value) })}
            />
            <span className="settings-value mono">{settings.fontScale.toFixed(2)}×</span>
          </div>

          <div className="settings-row">
            <span className="settings-label">字体</span>
            <select
              className="select"
              value={settings.fontFamily}
              onChange={(e) => patch({ fontFamily: e.target.value })}
            >
              {FONT_STACKS.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">行高</span>
            <input
              className="range"
              type="range"
              min={1.2}
              max={2.8}
              step={0.1}
              value={settings.lineHeight}
              onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
            />
            <span className="settings-value mono">{settings.lineHeight.toFixed(1)}</span>
          </div>

          <div className="settings-row">
            <span className="settings-label">页边距</span>
            <input
              className="range"
              type="range"
              min={0}
              max={96}
              step={4}
              value={settings.margin}
              onChange={(e) => patch({ margin: Number(e.target.value) })}
            />
            <span className="settings-value mono">{settings.margin}px</span>
          </div>

          <div className="settings-row">
            <span className="settings-label">书写方向</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.vertical}
                onChange={(e) => patch({ vertical: e.target.checked })}
              />
              <span>日文小说默认竖排（阅读器里按 v 可随时切换）</span>
            </label>
          </div>

          <p className="settings-hint">只调整阅读器注入的排版，不覆盖书自带的 CSS。</p>
        </section>
      </div>
    </div>
  );
}

/** 字体候选。刻意用系统字体栈而不是打包字体：CJK 字体动辄十几 MB，
 *  而 macOS/Windows 自带的明朝/ゴシック已经足够好。 */
const FONT_STACKS = [
  {
    label: '默认（明朝 / 宋体）',
    value: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", "Songti SC", serif',
  },
  {
    label: '黑体 / ゴシック',
    value: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "PingFang SC", sans-serif',
  },
  { label: '宋体', value: '"Songti SC", "SimSun", serif' },
  { label: '系统无衬线', value: 'system-ui, sans-serif' },
] as const;

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
