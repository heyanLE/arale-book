import { useEffect, useState } from 'react';
import type { ServerConnectionInput, ServerConnections, ServerScanStatus, ServerSyncStatus } from '@shared/server';
import { api, useIpcEvent } from '../lib/api';
import { SyncConnection } from './ServerSync';
const empty = { name: 'Arale Server', url: 'http://127.0.0.1:3737', token: '' };
export function ServersCard(): JSX.Element {
    const [sources, setSources] = useState<ServerConnections>({ activeId: null, connections: [] });
    const [draft, setDraft] = useState<ServerConnectionInput>(empty);
    const [busy, setBusy] = useState(false);
    const [scans,setScans]=useState<ServerScanStatus[]>([]);
    const [sync,setSync]=useState<ServerSyncStatus[]>([]);
    const [message, setMessage] = useState('');
    useEffect(() => { void api.sources?.connections().then(setSources).catch(e => setMessage(String(e))); }, []);
    useIpcEvent('sources:changed', setSources);
    useIpcEvent('sources:status',value=>{setScans(value.scans??[]);setSync(value.connections??[]);});
    useEffect(()=>{void api.sources.status().then(value=>{setScans(value.scans??[]);setSync(value.connections??[]);}).catch(()=>{});},[]);
    async function action(run: () => Promise<unknown>, success: string) { setBusy(true); setMessage('连接中…'); try {
        await run();
        setMessage(success);
    }
    catch (e) {
        setMessage(String(e));
    }
    finally {
        setBusy(false);
    } }
    return <section className="settings-card" id="settings-servers">
    <div className="settings-card-head"><h2 className="settings-card-title">服务器与书源</h2></div>
    <p className="settings-hint">本地书库与服务器书库独立保留。远程原图按需缓存，进度同步到服务器，OCR 可选本机或服务器执行；本机 OCR 结果暂存本机。词典、书签、笔记、批注和制卡资料仍保存在本机。</p>
    <div className="settings-row"><span className="settings-label">本地书库</span><button className="btn btn-sm" disabled={busy || !sources.activeId} onClick={() => void action(() => api.sources.activate(null), '已切换到本地书库')}>{sources.activeId ? '使用本地书库' : '当前书源'}</button></div>
    {sources.connections.map(c => <div key={c.id} className="server-connection">
      <strong>{c.name}{sources.activeId === c.id ? ' · 当前书源' : ''}</strong><span className="mono">{c.url}</span>
      {scans.find(s=>s.connectionId===c.id)?.running && <p role="status">正在扫描服务器书库…</p>}
      {scans.find(s=>s.connectionId===c.id)?.errors.map((error,index)=><p role="alert" key={index}>扫描失败：{error}</p>)}
      <SyncConnection connection={c} status={sync.find(s=>s.connectionId===c.id)} />
      <div className="settings-row">
        <button className="btn btn-sm" disabled={busy || sources.activeId === c.id} onClick={() => void action(() => api.sources.activate(c.id), '已切换服务器书库')}>使用此书库</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setDraft({ id: c.id, name: c.name, url: c.url, token: '' })}>编辑连接</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => void action(() => api.sources.scan(c.id), '已提交扫描，完成后点击同步获取新书')}>扫描服务器文件</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => void action(() => api.sources.remove(c.id), '连接已移除，缓存与本机学习资料保留')}>移除连接</button>
      </div>
    </div>)}
    <form onSubmit={e => { e.preventDefault(); void action(async () => { await api.sources.save(draft); setDraft(empty); }, '连接已保存，可在书库顶部选择服务器'); }}>
      <h3>{draft.id ? '编辑服务器' : '添加服务器'}</h3>
      <label className="settings-row"><span className="settings-label">显示名称</span><input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
      <label className="settings-row"><span className="settings-label">服务器 URL</span><input required type="url" placeholder="http://nas:3737" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })}/></label>
      <label className="settings-row"><span className="settings-label">访问令牌</span><input type="password" autoComplete="new-password" placeholder={draft.id ? '留空保留原令牌；修改地址需重填' : '服务端数据目录中的 access-token'} value={draft.token ?? ''} onChange={e => setDraft({ ...draft, token: e.target.value })}/></label>
      <div className="settings-row"><button type="button" className="btn" disabled={busy} onClick={() => void action(() => api.sources.probe(draft), '连接成功，服务器身份与 API 兼容')}>测试连接</button><button className="btn btn-primary" disabled={busy} type="submit">验证并保存</button>{draft.id && <button type="button" className="btn" onClick={() => setDraft(empty)}>取消编辑</button>}</div>
    </form><p role="status">{message}</p>
  </section>;
}
