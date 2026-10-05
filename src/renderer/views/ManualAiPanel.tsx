import { useEffect, useState } from 'react';
import type { StudyCardField, StudyList, StudyManualAiSession } from '@shared/types';
import { manualAiDocument } from '@core/study/manual-ai';
import { api } from '../lib/api';

export function ManualAiPanel(props: {
  bookId: string; bookTitle: string; kind: 'filter' | 'cards'; session?: StudyManualAiSession; fields?: StudyCardField[];
  disabled: boolean; running: boolean; beforeExport: () => Promise<boolean>; onChange: (list: StudyList) => void; onNext: () => void;
  pendingFilter: boolean; pendingCards: boolean;
}): JSX.Element {
  const { bookId, kind, session } = props;
  const [count, setCount] = useState('10');
  const [selectedBatch, setSelectedBatch] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (session) { setCount(String(session.tasksPerFile)); setSelectedBatch(session.batches.find(b => !b.completed)?.id ?? session.batches[0]?.id ?? ''); }
  }, [session?.id, session?.batches.filter(b => b.completed).length]);
  const batch = session?.batches.find(b => b.id === selectedBatch) ?? session?.batches[0];
  const invalidCount = !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 100;
  const locked = props.disabled || busy;
  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <div className="study-manual-ai-panel" aria-label={`${kind === 'filter' ? '筛词' : '词卡'}自行 AI`}>
    <p>{kind === 'cards' ? '将全部已选词按勾选字段交给外部 AI，提供辞书形、词典和前后句；已有句译作为参考。' : '将规则保留的候选交给外部 AI，排除 OCR 错词和噪声；人工强制保留项不送出。'}应用不发起 LLM 或翻译请求。</p>
    {(props.pendingFilter || props.pendingCards) && <div className="study-checkpoint-warning">
      还有应用内未完成检查点。请先续跑，或放弃后再导出自行 AI 任务。
      <button type="button" className="btn btn-sm" disabled={busy || props.running} onClick={() => {
        if (window.confirm('放弃应用内未完成筛词/词卡检查点？其中已花费的 token 无法恢复，已发布的完整结果保留。')) void act(async () => {
          if (props.pendingFilter) props.onChange(await api.study.clearFilterProgress(bookId));
          if (props.pendingCards) props.onChange(await api.study.clearCardProgress(bookId));
          setMessage('应用内未完成检查点已放弃，可以导出自行 AI 任务。');
        });
      }}>放弃应用内未完成检查点</button>
    </div>}
    <label>每份 MD 任务数量 <input type="number" aria-label="每份 MD 任务数量" min={1} max={100} value={count} disabled={locked || !!session} onChange={e => setCount(e.target.value)} /></label>
    {!session && <button type="button" className="btn btn-sm btn-primary" disabled={locked || props.pendingFilter || props.pendingCards || invalidCount || (kind === 'cards' && !props.fields?.length)} onClick={() => void act(async () => {
      if (!await props.beforeExport()) return;
      const next = await api.study.exportManualAi(bookId, { kind, tasksPerFile: Number(count), fields: props.fields });
      if (next) { props.onChange(next); setMessage('任务文件已生成。打开文件夹，上传一份 MD 到外部 AI，复制该批提示词，再将结果粘贴回来。'); }
    })}>生成任务文件</button>}
    {invalidCount && <small>请输入 1–100 的整数。</small>}
    {session && <>
      <p>已导入 {session.batches.filter(b => b.completed).length}/{session.batches.length} 份 · 共 {session.tasks.length} 个任务。进度已保存。</p>
      <ol className="manual-ai-instructions"><li>打开文件夹，将一个批次的 MD 文件上传到外部 AI。</li><li>复制该批提示词，发送给 AI。</li><li>将完整 JSON 粘贴到下方，校验并导入。</li></ol>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { await api.study.revealManualAi(bookId, kind); setMessage('已打开任务文件夹，可选择批次 MD 文件上传。'); })}>打开文件夹</button>
      <details><summary>任务目录</summary><p style={{ overflowWrap: 'anywhere' }}>{session.directory}</p></details>
      {session.fields && <small>本次字段：{session.fields.map(f => ({ reading: '假名', meaning: '本词含义', sentence: '原句', sentenceTranslation: '句子含义', lemma: '辞书形' })[f]).join('、')}。上方字段修改仅影响下一次导出。</small>}
      <div className="manual-ai-batches" aria-label="任务批次">{session.batches.map((b, index) => <div key={b.id} className={batch?.id === b.id ? 'is-active' : ''}>
        <button type="button" className="link-btn" onClick={() => setSelectedBatch(b.id)}>第 {index + 1} 批 · {b.fileName}</button>
        <span>{b.taskIds.length} 个任务 · {b.completed ? '已导入' : '待导入'}</span>
        <button type="button" className="btn btn-sm" disabled={busy} aria-label={`复制第 ${index + 1} 批提示词`} onClick={() => void act(async () => {
          await navigator.clipboard.writeText(b.prompt); setSelectedBatch(b.id); setMessage(`第 ${index + 1} 批提示词已复制，请上传 ${b.fileName}。`);
        })}>复制提示词</button>
      </div>)}</div>
      <label style={{ display: 'block' }}>简短提示词<textarea aria-label="自行 AI 提示词" readOnly value={batch?.prompt ?? ''} rows={3} style={{ width: '100%' }} /></label>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(batch?.prompt ?? ''); setMessage('提示词已复制，请同时上传对应 MD 文件。'); })}>复制提示词</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(async () => {
        await navigator.clipboard.writeText(manualAiDocument(session, session.batches.findIndex(b => b.id === batch?.id), props.bookTitle));
        setMessage('整份 MD 已复制，可直接粘贴到外部 AI。');
      })}>复制整份 MD</button>
      {!session.completedAt && <>
        <label style={{ display: 'block', marginTop: 12 }}>粘贴外部 AI 返回的完整 JSON<textarea aria-label="自行 AI 返回结果" rows={8} value={result} onChange={e => setResult(e.target.value)} placeholder="每次粘贴一份文件的完整结果；应用按 batchId 自动识别批次。" style={{ width: '100%' }} /></label>
        <button type="button" className="btn btn-sm btn-primary" disabled={locked || !result.trim()} onClick={() => void act(async () => {
          const next = await api.study.importManualAi(bookId, kind, result);
          props.onChange(next); setResult(''); setMessage(next.workflow?.manualAi?.[kind]?.completedAt ? '全部结果已导入，可以继续下一步。' : '本份结果已校验并保存，请继续导入剩余文件。');
        })}>校验并导入本份结果</button>
      </>}
      <div className="study-flow-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={locked || !session.completedAt} onClick={props.onNext}>继续{kind === 'filter' ? '手动筛词' : '审核并导出'}</button>
        <button type="button" className="btn btn-sm" disabled={busy || props.running} onClick={() => {
          if (window.confirm('清除此阶段的自行 AI 任务和导入进度？已完成并应用的筛词结果/卡片以及导出文件会保留。旧文件的结果将不能再导入。')) void act(async () => {
            props.onChange(await api.study.clearManualAi(bookId, kind)); setResult(''); setMessage('任务已清除，可重新选择数量和字段导出。');
          });
        }}>清除任务，重新准备</button>
      </div>
    </>}
    {message && <p role="status" style={{ overflowWrap: 'anywhere' }}>{message}</p>}
  </div>;
}

export function AiModeChoice(props: { label: string; manual: boolean; onChange: (manual: boolean) => void }): JSX.Element {
  return <div className="study-flow-actions" role="group" aria-label={props.label}>
    <button type="button" className={`btn btn-sm ${props.manual ? '' : 'btn-primary'}`} aria-pressed={!props.manual} onClick={() => props.onChange(false)}>应用内生成</button>
    <button type="button" className={`btn btn-sm ${props.manual ? 'btn-primary' : ''}`} aria-pressed={props.manual} onClick={() => props.onChange(true)}>外部 AI · 手动导入</button>
  </div>;
}
