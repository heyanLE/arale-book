import { useEffect, useState } from 'react';
import type { AppBuildInfo, AppUpdateResult } from '@shared/releases';
import { api, call, reportApiError } from '../lib/api';

const channels = { dev: '开发版', nightly: '每夜构建', release: '正式版' };

export function AppVersionCard(): JSX.Element {
  const [info, setInfo] = useState<AppBuildInfo | null>(null);
  const [result, setResult] = useState<AppUpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  useEffect(() => {
    let mounted = true;
    void call('读取版本', () => api.app.buildInfo()).then(value => { if (mounted) setInfo(value); });
    return () => { mounted = false; };
  }, []);

  const check = async () => {
    setBusy(true); setError(''); setResult(null); setCheckedAt('');
    try {
      setResult(await api.app.checkUpdate());
      setCheckedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message); reportApiError('检查更新', cause);
    } finally { setBusy(false); }
  };
  const message = result?.status === 'available' ? `发现新版本 ${result.version}`
    : result?.status === 'latest' ? '当前已是最新每夜构建'
    : result?.status === 'unpublished' ? '暂时没有可用的每夜构建'
    : result?.status === 'unsupported' ? '当前平台不在每夜构建支持范围内'
    : result?.status === 'disabled' ? '当前版本未启用更新检查' : '';

  return <section className="settings-card" id="settings-version">
    <div className="settings-card-head">
      <h2 className="settings-card-title">版本与更新</h2>
      <div className="settings-card-actions">
        <button type="button" className="btn btn-sm" disabled={!info || info.channel !== 'nightly' || busy} onClick={() => void check()}>{busy ? '检查中…' : '检查更新'}</button>
        <button type="button" className={`btn btn-sm${result?.status === 'available' ? ' btn-primary' : ''}`} onClick={() => void call('打开发布页面', () => api.app.openRelease(result?.tag ?? undefined))}>{result?.status === 'available' ? '下载新版本' : '打开发布页面'}</button>
      </div>
    </div>
    <div className="settings-row"><span className="settings-label">当前版本</span><span className="settings-value">{info ? `${channels[info.channel]} · ${info.version}` : '读取中…'}</span></div>
    {info && <div className="settings-row"><span className="settings-label">构建信息</span><span className="settings-value">{info.platform === 'windows' ? 'Windows' : info.platform === 'macos' ? 'macOS' : info.platform} · {info.arch === 'aarch64' ? 'Apple Silicon' : info.arch === 'x86_64' ? 'x64' : info.arch}{info.commit ? ` · ${info.commit.slice(0, 8)}` : ''}{info.builtAt ? ` · ${new Date(info.builtAt).toLocaleString()}` : ''}</span></div>}
    <p className="settings-hint" role="status" aria-live="polite">{busy ? '正在检查 GitHub 发布…' : error ? `检查失败：${error}` : message ? `${message}${checkedAt ? `（${checkedAt}）` : ''}` : info?.channel === 'dev' ? '开发版不检查更新。' : info?.channel === 'release' ? '正式版更新尚未启用。' : '检查每夜构建更新；下载后手动安装。'}</p>
  </section>;
}
