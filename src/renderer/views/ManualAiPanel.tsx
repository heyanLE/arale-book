import { useEffect, useState } from 'react';
import type { StudyCardField, StudyList, StudyManualAiSession } from '@shared/types';
import { manualAiDocument } from '@core/study/manual-ai';
import { api } from '../lib/api';

const FIELD_NAMES: Record<StudyCardField, string> = { reading: '假名', meaning: '词义', sentence: '原句', sentenceTranslation: '句译', lemma: '辞书形', etymology: '舶来语词源' };
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
  const [error, setError] = useState('');
  const [copiedBatch, setCopiedBatch] = useState('');
  useEffect(() => {
    if (session) { setCount(String(session.tasksPerFile)); setSelectedBatch(session.batches.find(b => !b.completed)?.id ?? session.batches[0]?.id ?? ''); }
  }, [session?.id, session?.batches.filter(b => b.completed).length]);
  const batch = session?.batches.find(b => b.id === selectedBatch) ?? session?.batches[0];
  const index = session?.batches.findIndex(b => b.id === batch?.id) ?? 0;
  const completed = session?.batches.filter(b => b.completed).length ?? 0;
  const invalidCount = !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 100;
  const locked = props.disabled || busy;
  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true); setMessage(''); setError('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <div className="study-manual-ai-panel" aria-label={`${kind === 'filter' ? '筛词' : '词卡'}自行 AI`}>
    <ol className="manual-ai-journey" aria-label="外部 AI 操作流程">
      <li className={session ? 'is-complete' : 'is-current'}><b>1</b><span>准备任务<small>{session ? `${session.tasks.length} 词已准备` : '按词数分批'}</small></span></li>
      <li className={session && !session.completedAt ? 'is-current' : ''}><b>2</b><span>交给外部 AI<small>复制完整任务并发送</small></span></li>
      <li className={session?.completedAt ? 'is-complete' : ''}><b>3</b><span>粘贴返回结果<small>导入后自动保存进度</small></span></li>
    </ol>
    {(props.pendingFilter || props.pendingCards) && <div className="study-checkpoint-warning">
      有应用内任务尚未完成。继续原任务，或放弃未完成部分后使用外部 AI。
      <button type="button" className="btn btn-sm" disabled={busy || props.running} onClick={() => {
        if (window.confirm('放弃应用内未完成筛词/词卡检查点？已完成并发布的结果保留。')) void act(async () => {
          if (props.pendingFilter) props.onChange(await api.study.clearFilterProgress(bookId));
          if (props.pendingCards) props.onChange(await api.study.clearCardProgress(bookId));
        });
      }}>放弃未完成部分</button>
    </div>}
    {!session && <div className="manual-ai-prepare">
      <h4>准备{kind === 'cards' ? '词卡生成' : '筛词'}任务</h4>
      <p>无需配置 API Key。把完整任务粘贴到你使用的 AI 对话，再把答案带回来。</p>
      <label>每批词数 <input type="number" aria-label="每份 MD 任务数量" min={1} max={100} value={count} disabled={locked} onChange={e => setCount(e.target.value)} /></label>
      <small>默认每批 10 词；较小批次更容易一次返回完整答案。</small>
      {props.fields && <p>生成内容：{props.fields.map(field => FIELD_NAMES[field]).join('、')}</p>}
      <button type="button" className="btn btn-primary" disabled={locked || props.pendingFilter || props.pendingCards || invalidCount || (kind === 'cards' && !props.fields?.length)} onClick={() => void act(async () => {
        if (!await props.beforeExport()) return;
        const next = await api.study.exportManualAi(bookId, { kind, tasksPerFile: Number(count), fields: props.fields });
        if (next) { props.onChange(next); setMessage('任务已准备好。下一步：复制当前批次，发送给外部 AI。'); }
      })}>准备任务，开始第 1 批</button>
      {invalidCount && <p role="alert">请输入 1–100 的整数。</p>}
    </div>}
    {session && <>
      <div className="manual-ai-progress" role="status"><strong>{session.completedAt ? '全部结果已导入' : `已完成 ${completed} / ${session.batches.length} 批`}</strong>
        <progress value={completed} max={session.batches.length} aria-label="外部 AI 批次完成进度" />
        <span>{session.tasks.length} 个词 · 进度已保存，可稍后继续</span></div>
      {!session.completedAt && <>
        <div className="manual-ai-batch-heading"><label>当前批次 <select aria-label="当前外部 AI 批次" value={batch?.id ?? ''} disabled={busy || !!result.trim()} onChange={event => { setSelectedBatch(event.target.value); setCopiedBatch(''); }}>
          {session.batches.map((one, i) => <option key={one.id} value={one.id}>第 {i + 1} 批 · {one.taskIds.length} 词 · {one.completed ? '已导入' : '待处理'}</option>)}
        </select></label></div>
        <section className="manual-ai-task">
          <h4>发送第 {index + 1} 批给 AI</h4><p>任务包含原句、词典资料和返回格式。直接粘贴到 AI 对话即可。</p>
          <button type="button" className="btn btn-primary" disabled={busy || batch?.completed} onClick={() => void act(async () => {
            await navigator.clipboard.writeText(manualAiDocument(session, index, props.bookTitle));
            setCopiedBatch(batch!.id); setMessage(`第 ${index + 1} 批完整任务已复制。粘贴到外部 AI，等待答案后返回这里。`);
          })}>{copiedBatch === batch?.id ? '已复制 · 再复制本批任务' : '复制本批完整任务'}</button>
          <details className="manual-ai-task-preview"><summary>查看本批完整任务</summary><textarea aria-label="完整任务内容" readOnly rows={10} value={manualAiDocument(session, index, props.bookTitle)} /></details>
          <details className="manual-ai-file-option"><summary>使用文件附件发送</summary>
            <p>上传 <strong>{batch?.fileName}</strong>，再发送简短提示词。</p>
            <div className="study-workflow-controls"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { await api.study.revealManualAi(bookId, kind); setMessage(`已打开文件夹，请上传 ${batch?.fileName}。`); })}>打开任务文件夹</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { await navigator.clipboard.writeText(batch?.prompt ?? ''); setMessage('提示词已复制，请连同当前批次文件发送。'); })}>复制附件提示词</button></div>
            <textarea aria-label="自行 AI 提示词" readOnly value={batch?.prompt ?? ''} rows={3} />
            <small className="manual-ai-directory">{session.directory}</small>
          </details>
        </section>
        <section className="manual-ai-return"><h4>粘贴 AI 的返回结果</h4>
          <label>本批完整 JSON<textarea aria-label="自行 AI 返回结果" rows={7} value={result} onChange={event => setResult(event.target.value)} placeholder="把 AI 返回的完整 JSON 粘贴到这里。格式错误时会保留输入，便于修改。" disabled={busy || batch?.completed} /></label>
          {batch?.completed && <p>该批已导入，请在上方选择未完成的批次。</p>}
          {error && <p className="study-issue" role="alert">{error}</p>}
          <button type="button" className="btn btn-primary" disabled={locked || batch?.completed || !result.trim()} onClick={() => void act(async () => {
            const next = await api.study.importManualAi(bookId, kind, result);
            props.onChange(next); setResult(''); setCopiedBatch('');
            setMessage(next.workflow?.manualAi?.[kind]?.completedAt ? '全部结果已保存。继续预览并导出卡片。' : '本批已保存，已切换到下一待处理批次。');
          })}>{busy ? '正在导入…' : '导入结果，继续下一批'}</button>
          {result && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setResult(''); setError(''); }}>清空输入</button>}
        </section>
      </>}
      {session.completedAt && <div className="manual-ai-complete"><strong>{completed} 批任务已完成</strong><p>{kind === 'filter' ? '接下来确认要保留的词，再生成卡片。' : '接下来查看卡片内容、词源和漫画截图，再导出 Anki。'}</p>
        <button type="button" className="btn btn-primary" disabled={locked} onClick={props.onNext}>继续：{kind === 'filter' ? '确认词单' : '预览与导出'}</button></div>}
      <details className="manual-ai-management"><summary>任务设置与重新准备</summary>
        <p>每批 {session.tasksPerFile} 词{session.fields ? ` · ${session.fields.map(field => FIELD_NAMES[field]).join('、')}` : ''}</p>
        <button type="button" className="btn btn-sm" disabled={busy || props.running} onClick={() => {
          if (window.confirm('清除本阶段的批次进度并重新准备？已完成卡片和导出的文件保留。旧任务答案将不能再导入。')) void act(async () => {
            props.onChange(await api.study.clearManualAi(bookId, kind)); setResult(''); setMessage('可以重新选择词数和字段准备任务。');
          });
        }}>清除任务，重新准备</button></details>
    </>}
    {error && (!session || session.completedAt) && <p className="study-issue" role="alert">{error}</p>}
    {message && <p className="manual-ai-feedback" role="status">{message}</p>}
  </div>;
}

export function AiModeChoice(props: { label: string; manual: boolean; onChange: (manual: boolean) => void; disabled?: boolean; kind?: 'filter' | 'cards' }): JSX.Element {
  return <div className="study-ai-mode" role="group" aria-label={props.label}>
    <button type="button" className={props.manual ? '' : 'is-active'} aria-pressed={!props.manual} disabled={props.disabled} onClick={() => props.onChange(false)}><strong>在应用内完成</strong><small>{props.kind === 'filter' ? '使用已配置的模型筛选词单' : '使用已配置的模型与翻译服务'}</small></button>
    <button type="button" className={props.manual ? 'is-active' : ''} aria-pressed={props.manual} disabled={props.disabled} onClick={() => props.onChange(true)}><strong>交给外部 AI</strong><small>复制任务 → 粘贴答案，无需 API Key</small></button>
  </div>;
}
