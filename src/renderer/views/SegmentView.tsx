/**
 * 分词视图：看一本书的词表，并生成 / 重新生成 / 删除分词结果。
 *
 * 为什么单独做一个视图而不是塞进阅读器侧栏：分词是**离线批处理产物**，用户看它的
 * 目的通常是「这本书里有哪些词、各出现几次」——那是个列表浏览任务，跟翻页阅读是
 * 两种不同的活动。放在阅读器里只会互相挤。
 *
 * 三种状态都要照顾到：
 * 1. 没生成过 → 解释这是什么、点了会发生什么；
 * 2. 正在生成 → 进度（分词比 OCR 快得多，但仍然可能几百页）；
 * 3. 已生成 → 词表 + 生成时间 + 用的是哪本词典，并提示「换了词典要重新生成」。
 */

import { useMemo, useState } from 'react';
import type { BookSegments, SegmentJobResult, SegmentProgress } from '@shared/types';

export interface SegmentViewProps {
  bookId: string;
  bookTitle: string;
  /** 这本书最近一次分词任务的结束状态（没跑过为 null）。 */
  status: SegmentJobResult | null;
  /** 正在进行的任务进度（没在跑为 null）。 */
  progress: SegmentProgress | null;
  /** 已落盘的分词结果（没生成过为 null）。 */
  segments: BookSegments | null;
  /** 加载中标志（首次读盘）。 */
  loading: boolean;
  onBack: () => void;
  onGenerate: (force: boolean) => void;
  onClear: () => void;
  onReload: () => void;
}

const STAGE_TEXT: Record<SegmentProgress['stage'], string> = {
  reading: '正在读取原文',
  segmenting: '正在分词',
  writing: '正在写入结果',
  done: '完成',
  failed: '失败',
};

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SegmentView(props: SegmentViewProps): JSX.Element {
  const { bookTitle, status, progress, segments, loading, onBack, onGenerate, onClear, onReload } =
    props;

  const [filter, setFilter] = useState('');
  const [onlyMatched, setOnlyMatched] = useState(false);

  const running = progress !== null;

  const vocabulary = useMemo(() => {
    const entries = segments?.vocabulary ?? [];
    const needle = filter.trim().toLowerCase();
    return entries.filter((entry) => {
      if (onlyMatched && !entry.matched) return false;
      if (needle === '') return true;
      return (
        entry.base.toLowerCase().includes(needle) ||
        entry.surfaces.some((surface) => surface.toLowerCase().includes(needle))
      );
    });
  }, [segments, filter, onlyMatched]);

  /** 词表里未命中词典的比例——低了说明词典没装好或者没覆盖这本书。 */
  const matchedRatio = useMemo(() => {
    const entries = segments?.vocabulary ?? [];
    if (entries.length === 0) return 0;
    return entries.filter((entry) => entry.matched).length / entries.length;
  }, [segments]);

  return (
    <div className="segment-view">
      <div className="segment-head">
        <button type="button" className="btn btn-sm" onClick={onBack} title="返回书库">
          ← 书库
        </button>
        <div className="segment-heading">
          <div className="segment-title cell-ellipsis" title={bookTitle}>
            {bookTitle}
          </div>
          <div className="segment-sub">
            分词 ·{' '}
            {segments
              ? `${segments.vocabulary.length} 个词 / ${segments.units.length} 个单元 · ${formatTime(segments.generatedAt)}`
              : '尚未生成'}
          </div>
        </div>
        <div className="segment-actions">
          <button type="button" className="btn btn-sm" onClick={onReload} title="重新读盘">
            刷新
          </button>
          {segments && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onClear}
              title="删除分词结果（原文不受影响）"
            >
              删除
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={running}
            onClick={() => onGenerate(segments !== null)}
            title={
              segments
                ? '用当前词典重新分词（换词典或改过文字层后应该重跑）'
                : '按当前词典给这本书分词并保存词表'
            }
          >
            {running ? '生成中…' : segments ? '重新生成' : '生成分词'}
          </button>
        </div>
      </div>

      {running && progress && (
        <div className="segment-progress">
          <div className="segment-progress-bar">
            <div
              className="segment-progress-fill"
              style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <span className="segment-progress-text">
            {STAGE_TEXT[progress.stage]} · {progress.done} / {progress.total}
            {progress.message ? ` · ${progress.message}` : ''}
          </span>
        </div>
      )}

      {!segments && !running && !loading && (
        <div className="segment-empty">
          <div className="segment-empty-title">这本书还没有分词结果</div>
          <div className="segment-empty-hint">
            点右上角「生成分词」会按**当前词典**把全书切词并保存成词表。
            <br />
            它不影响阅读，也不会改动原文；换词典之后点「重新生成」即可。
            <br />
            漫画要先有文字层（`.mokuro` / `manga.json`，或者跑一次 OCR）才有东西可分。
          </div>
        </div>
      )}

      {loading && <div className="segment-empty">正在读取分词结果…</div>}

      {status && !status.ok && !running && (
        <div className="segment-error">上次分词失败：{status.error ?? '未知原因'}</div>
      )}

      {segments && (
        <>
          <div className="segment-toolbar">
            <input
              className="segment-search"
              type="search"
              placeholder="筛选词…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <label className="segment-toggle">
              <input
                type="checkbox"
                checked={onlyMatched}
                onChange={(event) => setOnlyMatched(event.target.checked)}
              />
              只看词典收录的
            </label>
            <span className="segment-meta">
              显示 {vocabulary.length} / {segments.vocabulary.length} 个词 · 词典收录{' '}
              {Math.round(matchedRatio * 100)}%
              {segments.dictionaryCount === 0 && '（当前没装词典，只有占位切分）'}
            </span>
          </div>

          {vocabulary.length === 0 ? (
            <div className="segment-empty">没有匹配的词。</div>
          ) : (
            <div className="segment-list" role="list">
              {vocabulary.slice(0, 400).map((entry) => (
                <div className="segment-row" role="listitem" key={entry.base}>
                  <span className="segment-word">{entry.base}</span>
                  <span className="segment-count mono">×{entry.count}</span>
                  {entry.surfaces.length > 1 && (
                    <span className="segment-surfaces cell-ellipsis" title={entry.surfaces.join('、')}>
                      {entry.surfaces.join('、')}
                    </span>
                  )}
                  {!entry.matched && <span className="segment-chip">词典未收录</span>}
                </div>
              ))}
            </div>
          )}
          {vocabulary.length > 400 && (
            <div className="segment-more">只显示前 400 个，用上面的筛选框缩小范围</div>
          )}
        </>
      )}
    </div>
  );
}
