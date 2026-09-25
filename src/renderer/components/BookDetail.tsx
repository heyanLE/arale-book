/**
 * 右侧书籍详情面板（可开关）。
 *
 * 信息密度优先：元数据是「标签 : 值」两列的密集表，而不是一堆大卡片。可编辑字段走
 * 「编辑 → 保存/取消」的显式提交，避免每敲一个字就发一次 IPC。
 */

import { useEffect, useState } from 'react';
import { readerModeOf, type BookRecord } from '@shared/types';
import { assetUrl } from '../lib/api';

/** `library.updateMeta` 接受的补丁形状（从冻结契约里派生，别手写第二份）。 */
export type BookMetaPatch = Partial<
  Pick<BookRecord, 'title' | 'author' | 'series' | 'volume' | 'tags' | 'direction' | 'readerMode'>
>;

export interface BookDetailProps {
  book: BookRecord | null;
  /** 当前选中的全部 id（真相源在 App）。长度 > 1 时面板切换成多选形态。 */
  selectedIds: string[];
  onOpen: (bookId: string) => void;
  onRemove: (bookIds: string[]) => void;
  onReveal: (bookId: string) => void;
  onUpdateMeta: (bookId: string, patch: BookMetaPatch) => void;
  onFilterTag: (tag: string) => void;
  onClose: () => void;
}

interface Draft {
  title: string;
  author: string;
  series: string;
  volume: string;
  tags: string;
}

export function BookDetail(props: BookDetailProps): JSX.Element {
  const { book, selectedIds, onOpen, onRemove, onReveal, onUpdateMeta, onFilterTag, onClose } =
    props;
  const selectionCount = selectedIds.length;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({ title: '', author: '', series: '', volume: '', tags: '' });

  // 换书就退出编辑态，避免把 A 的草稿存到 B 上。
  useEffect(() => {
    setEditing(false);
  }, [book?.id]);

  if (selectionCount > 1) {
    return (
      <aside className="detail">
        <DetailHeader title={`已选 ${selectionCount} 本`} onClose={onClose} />
        <div className="detail-body">
          <p className="detail-hint">多选状态下不显示单本字段。</p>
          <div className="detail-actions">
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => onRemove(selectedIds)}
            >
              移除选中的 {selectionCount} 本…
            </button>
          </div>
        </div>
      </aside>
    );
  }

  if (!book) {
    return (
      <aside className="detail">
        <DetailHeader title="书籍详情" onClose={onClose} />
        <div className="detail-body">
          <p className="detail-hint">选中一本书查看详情。</p>
        </div>
      </aside>
    );
  }

  const cover = assetUrl(book.id, book.coverRel);

  const beginEdit = () => {
    setDraft({
      title: book.title,
      author: book.author,
      series: book.series ?? '',
      volume: book.volume === null ? '' : String(book.volume),
      tags: book.tags.join(', '),
    });
    setEditing(true);
  };

  const commit = () => {
    const patch: BookMetaPatch = {
      title: draft.title.trim() === '' ? book.title : draft.title.trim(),
      author: draft.author.trim(),
      series: draft.series.trim() === '' ? null : draft.series.trim(),
      volume: parseVolume(draft.volume),
      tags: draft.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    };
    onUpdateMeta(book.id, patch);
    setEditing(false);
  };

  return (
    <aside className="detail">
      <DetailHeader title={book.title} onClose={onClose} />

      <div className="detail-body">
        <div className="detail-cover-wrap">
          {cover ? (
            <img className="detail-cover" src={cover} alt="" decoding="async" />
          ) : (
            <div className={`detail-cover cover-placeholder cover-${book.format}`}>
              <span>{book.title.slice(0, 1) || '书'}</span>
            </div>
          )}
        </div>

        {editing ? (
          <div className="detail-form">
            <label className="field">
              <span className="field-label">标题</span>
              <input
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">作者</span>
              <input
                className="input"
                value={draft.author}
                onChange={(e) => setDraft({ ...draft, author: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">系列</span>
              <input
                className="input"
                value={draft.series}
                onChange={(e) => setDraft({ ...draft, series: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">卷号</span>
              <input
                className="input"
                value={draft.volume}
                inputMode="numeric"
                onChange={(e) => setDraft({ ...draft, volume: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">标签</span>
              <input
                className="input"
                value={draft.tags}
                placeholder="逗号分隔"
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              />
            </label>
            <div className="detail-actions">
              <button type="button" className="btn btn-primary" onClick={commit}>
                保存
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="detail-title">{book.title}</div>
            <div className="detail-sub">{book.author || '未知作者'}</div>

            <dl className="detail-fields">
              <Field label="格式" value={book.format === 'epub' ? 'EPUB 小说' : '漫画'} />
              <Field
                label="阅读方式"
                value={
                  // 图片型小说：载体是 EPUB，但整本都是图，得用翻页阅读器。
                  // 只在「有页图」时才允许切 —— 纯文字书没有 pages，切过去就是空白。
                  (book.pages ?? []).length > 0 ? (
                    <button
                      type="button"
                      className="link-btn"
                      title="在小说阅读器与漫画阅读器之间切换"
                      onClick={() =>
                        onUpdateMeta(book.id, {
                          readerMode: readerModeOf(book) === 'epub' ? 'comic' : 'epub',
                        })
                      }
                    >
                      {readerModeOf(book) === 'epub' ? '小说阅读器' : '漫画阅读器（翻页）'}
                    </button>
                  ) : (
                    '小说阅读器'
                  )
                }
              />
              <Field label="系列" value={book.series ?? '—'} />
              <Field label="卷号" value={book.volume === null ? '—' : String(book.volume)} />
              <Field label="页数" value={String(book.pageCount)} mono />
              <Field
                label="阅读方向"
                value={book.direction === 'rtl' ? '从右到左 (RTL)' : '从左到右 (LTR)'}
              />
              <Field label="语言" value={book.language ?? '—'} />
              <Field label="出版" value={book.publisher ?? '—'} />
              <Field label="添加" value={formatDateTime(book.addedAt)} mono />
              <Field label="更新" value={formatDateTime(book.updatedAt)} mono />
              <Field
                label="上次阅读"
                value={book.lastOpenedAt === null ? '从未' : formatDateTime(book.lastOpenedAt)}
                mono
              />
              <Field label="书籍 ID" value={book.id} mono />
            </dl>

            <div className="detail-block">
              <div className="detail-block-title">标签</div>
              {book.tags.length === 0 ? (
                <div className="detail-hint">无标签</div>
              ) : (
                <div className="tag-row">
                  {book.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag-chip"
                      onClick={() => onFilterTag(tag)}
                      title={`按标签「${tag}」筛选`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {book.description !== null && book.description.trim() !== '' && (
              <div className="detail-block">
                <div className="detail-block-title">简介</div>
                <div className="detail-desc">{book.description}</div>
              </div>
            )}

            <div className="detail-block">
              <div className="detail-block-title">位置</div>
              <div className="detail-path mono" title={book.dir}>
                {book.dir}
              </div>
            </div>

            <div className="detail-actions detail-actions-stack">
              <button type="button" className="btn btn-primary btn-block" onClick={() => onOpen(book.id)}>
                打开阅读
              </button>
              <button type="button" className="btn btn-block" onClick={beginEdit}>
                编辑元数据
              </button>
              <button
                type="button"
                className="btn btn-block"
                onClick={() =>
                  onUpdateMeta(book.id, { direction: book.direction === 'rtl' ? 'ltr' : 'rtl' })
                }
              >
                切换阅读方向（当前：{book.direction.toUpperCase()}）
              </button>
              <button type="button" className="btn btn-block" onClick={() => onReveal(book.id)}>
                在文件夹中显示
              </button>
              <button
                type="button"
                className="btn btn-danger btn-block"
                onClick={() => onRemove([book.id])}
              >
                从书库移除…
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function DetailHeader({ title, onClose }: { title: string; onClose: () => void }): JSX.Element {
  return (
    <div className="detail-header">
      <span className="detail-header-title cell-ellipsis" title={title}>
        {title}
      </span>
      <button type="button" className="icon-btn" onClick={onClose} title="关闭详情面板 (Esc)">
        ×
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  /** ReactNode 而不只是 string：有的字段要放按钮（如「阅读方式」的切换）。 */
  value: React.ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <>
      <dt className="detail-label">{label}</dt>
      <dd className={`detail-value${mono ? ' mono' : ''}`} title={typeof value === 'string' ? value : undefined}>
        {value}
      </dd>
    </>
  );
}

function parseVolume(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
