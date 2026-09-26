/**
 * 「扩展」设置卡片：可下载安装的能力包。
 *
 * ## 这一页要回答的三个问题
 *
 * 扩展是几百 MB 的下载，所以用户点之前必须能回答：
 * 1. **这是什么、要下多大**——名字、说明、`bytes`/`installedBytes`；
 * 2. **我现在下到哪了**——下载/校验/解包三个阶段分别显示，不能只有一个转圈；
 * 3. **失败了我该干嘛**——错误文本原样显示（含 HTTP 状态码与 sha256 对比），
 *    而不是压成一句「安装失败」。
 *
 * ## 为什么把「进度」和「列表」放在一起渲染
 *
 * 进度是**按扩展 id** 来的（`extensions:progress` 事件）。分开渲染的话，列表项
 * 和进度条之间要再同步一次「哪一条在装」，那个同步状态很容易和真实状态漂移
 * （取消之后进度条还挂着）。这里直接按 id 查，单一真相源。
 */

import { useState } from 'react';
import type { ExtensionProgress, ExtensionStatus, OcrRepository } from '@shared/extensions';

export interface ExtensionsCardProps {
  statuses: ExtensionStatus[];
  repositories: OcrRepository[];
  /** 清单来源：远端缓存 / 本地开发仓库 / 没有。 */
  source: 'cache' | 'bundled' | 'none';
  /** 清单本身的问题（远端刷新失败等）。 */
  error: string | null;
  progress: Record<string, ExtensionProgress>;
  loading: boolean;
  onRefresh: () => void;
  onInstall: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onAddRepository: (name: string, url: string) => void;
  onRemoveRepository: (url: string) => void;
}

export function ExtensionsCard(props: ExtensionsCardProps): JSX.Element {
  const { statuses, repositories, source, error, progress, loading, onRefresh, onInstall, onCancel, onRemove, onAddRepository, onRemoveRepository } =
    props;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">扩展</h2>
        <div className="settings-card-actions">
          <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={loading}>
            {loading ? '刷新中…' : '刷新清单'}
          </button>
        </div>
      </div>

      <div className="settings-list" aria-label="OCR 仓库">
        {repositories.map((repo) => (
          <div className="settings-row settings-row-block" key={repo.url}>
            <div className="settings-row-main">
              <span className="settings-row-title">{repo.name}</span>
              <span className="settings-row-sub mono">{repo.url}</span>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => onRemoveRepository(repo.url)}>移除仓库</button>
          </div>
        ))}
      </div>
      <div className="settings-card-actions">
        <input aria-label="仓库名称" placeholder="仓库名称" value={name} onChange={(event) => setName(event.target.value)} />
        <input aria-label="仓库 JSONL 地址" placeholder="https://…/repository.jsonl" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button type="button" className="btn btn-sm" disabled={!name.trim() || !url.trim()} onClick={() => {
          onAddRepository(name, url);
          setName(''); setUrl('');
        }}>添加仓库</button>
      </div>

      {source === 'bundled' && (
        <p className="settings-note settings-warn">
          正在使用随包提供的 OCR 仓库索引。点「刷新清单」可获取远端版本。
        </p>
      )}
      {source === 'none' && (
        <p className="settings-note settings-warn">
          读不到任何扩展清单：{error ?? '原因未知'}。扩展功能暂时不可用。
        </p>
      )}
      {source !== 'none' && error !== null && (
        <p className="settings-note settings-warn">上次刷新清单失败：{error}</p>
      )}

      <div className="settings-list">
        {statuses.map((status) => (
          <ExtensionRow
            key={status.entry.id}
            status={status}
            progress={progress[status.entry.id] ?? null}
            onInstall={onInstall}
            onCancel={onCancel}
            onRemove={onRemove}
          />
        ))}
        {statuses.length === 0 && <div className="detail-hint">清单里还没有可用的扩展。</div>}
      </div>
    </section>
  );
}

function ExtensionRow(props: {
  status: ExtensionStatus;
  progress: ExtensionProgress | null;
  onInstall: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const { status, progress, onInstall, onCancel, onRemove } = props;
  const { entry, installed, updateAvailable, supported, unsupportedReason } = status;

  const busy =
    progress !== null && progress.phase !== 'done' && progress.phase !== 'failed';
  const ratio = progress !== null && progress.total > 0 ? progress.received / progress.total : 0;

  return (
    <div className={`settings-row settings-row-block${busy ? ' is-busy' : ''}`}>
      <div className="settings-row-main">
        <span className="settings-row-title">
          {entry.name}
          <span className="segment-chip mono">v{entry.version}</span>
          {installed !== null && !updateAvailable && <span className="segment-chip">已安装</span>}
          {installed?.local && <span className="segment-chip">本地开发</span>}
          {updateAvailable && <span className="segment-chip">可更新</span>}
          {!supported && <span className="segment-chip">不适用本机</span>}
        </span>
        <span className="settings-row-sub">{entry.summary}</span>
        <span className="settings-row-sub mono">
          {entry.bytes > 0 ? `下载 ${formatBytes(entry.bytes)}` : '下载大小未知'}
          {entry.installedBytes > 0 ? ` · 安装后约 ${formatBytes(entry.installedBytes)}` : ''}
          {entry.license !== '' ? ` · ${entry.license}` : ''}
          {entry.notes !== '' ? ` · ${entry.notes}` : ''}
        </span>

        {progress !== null && (
          <div className="ext-progress">
            <div className="ext-progress-bar" aria-hidden="true">
              <div
                className={`ext-progress-fill is-${progress.phase}`}
                style={{ width: progress.phase === 'downloading' ? `${Math.round(ratio * 100)}%` : '100%' }}
              />
            </div>
            <span className="ext-progress-text mono">
              {phaseLabel(progress.phase)}
              {progress.phase === 'downloading' && progress.total > 0
                ? ` ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
                : ''}
              {progress.message !== '' ? ` · ${progress.message}` : ''}
            </span>
          </div>
        )}

        {progress?.phase === 'failed' && progress.message !== '' && (
          <span className="settings-row-sub settings-err">{progress.message}</span>
        )}
        {!supported && unsupportedReason !== null && (
          <span className="settings-row-sub">{unsupportedReason}</span>
        )}
      </div>

      <div className="ext-actions">
        {busy ? (
          <button type="button" className="btn btn-sm" onClick={() => onCancel(entry.id)}>
            取消
          </button>
        ) : installed?.local ? null : installed !== null ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onInstall(entry.id)}
              disabled={!supported}
              title={updateAvailable ? '重新下载并覆盖安装' : '重新安装（会重新下载）'}
            >
              {updateAvailable ? '更新' : '重装'}
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => onRemove(entry.id)}>
              卸载
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => onInstall(entry.id)}
            disabled={!supported}
            title={supported ? `下载并安装（${formatBytes(entry.bytes)}）` : (unsupportedReason ?? '')}
          >
            安装
          </button>
        )}
      </div>
    </div>
  );
}

const PHASE_TEXT: Record<ExtensionProgress['phase'], string> = {
  resolving: '准备中',
  downloading: '下载中',
  verifying: '校验中',
  extracting: '解包中',
  done: '完成',
  failed: '失败',
};

function phaseLabel(phase: ExtensionProgress['phase']): string {
  return PHASE_TEXT[phase];
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
