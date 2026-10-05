/**
 * 右侧的**词卡夹**：这本书保存过的所有词卡。
 *
 * 点一条就重新弹出一张词卡（`openCard` 会重查词典，因为词卡不存释义——换词典之后
 * 打开旧卡看到的应该是最新释义，而不是当初那份快照）。
 *
 * 列表按最新在前排：刚存的卡应该在顶上，而不是要翻到底。
 */

import { useState } from 'react';
import type { WordCard } from '@shared/types';

export interface WordCardPanelProps {
  cards: WordCard[];
  onOpen: (card: WordCard) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  embedded?: boolean;
}

export function WordCardPanel({ cards, onOpen, onRemove, onClose, embedded = false }: WordCardPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const sources = [...new Set(cards.map(card => card.source ? card.source.kind === 'comic' ? `页 ${card.source.pageIndex + 1}` : `章 ${card.source.spineIndex + 1}` : '无位置'))];
  const shown = cards.filter(card => (!query.trim() || `${card.word} ${card.dictionaryExpression} ${card.note}`.toLowerCase().includes(query.trim().toLowerCase())) &&
    (sourceFilter === 'all' || sourceFilter === (card.source ? card.source.kind === 'comic' ? `页 ${card.source.pageIndex + 1}` : `章 ${card.source.spineIndex + 1}` : '无位置')));
  return (
    <div className={`wordcard-panel${embedded ? ' is-embedded' : ''}`}>
      {!embedded && <div className="wordcard-panel-head">
        <span className="wordcard-panel-title">词卡夹</span>
        <span className="wordcard-panel-count mono">{cards.length}</span>
        <span className="dict-popup-spacer" />
        <button type="button" className="icon-btn" onClick={onClose} title="收起词卡夹">
          ×
        </button>
      </div>}

      <div className="wordcard-panel-filters"><input type="search" aria-label="搜索已保存词卡" placeholder="搜索词语、辞书形或备注" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="词卡出处筛选" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">全部页／章</option>{sources.map(source => <option key={source}>{source}</option>)}</select>
        <small>显示 {shown.length} / {cards.length} 张</small></div>
      <div className="wordcard-panel-list">
        {cards.length === 0 ? (
          <div className="detail-hint">
            还没有保存过词卡。查词后点词卡上的「保存到词卡」。
          </div>
        ) : (
          shown.length ? shown.map((card) => (
            <div className="wordcard-item" key={card.id}>
              <button
                type="button"
                className="wordcard-item-main"
                onClick={() => onOpen(card)}
                title="打开这张词卡"
              >
                <span className="wordcard-item-word">{card.word}</span>
                {card.source && <span className="wordcard-item-source mono">{card.source.kind === 'comic' ? `第 ${card.source.pageIndex + 1} 页` : `第 ${card.source.spineIndex + 1} 章`}</span>}
                {card.dictionaryExpression !== '' &&
                  card.dictionaryExpression !== card.word && (
                    <span className="wordcard-item-dict">{card.dictionaryExpression}</span>
                  )}
                {card.dictionaryTitle !== '' && (
                  <span className="wordcard-item-source mono">{card.dictionaryTitle}</span>
                )}
                {card.analyses.length > 0 && (
                  <span className="wordcard-item-chip">LLM {card.analyses.length}</span>
                )}
                {card.note !== '' && <span className="wordcard-item-note">{card.note}</span>}
              </button>
              <button
                type="button"
                className="icon-btn wordcard-item-remove"
                onClick={() => onRemove(card.id)}
                title="从词卡夹里删掉"
              >
                ×
              </button>
            </div>
          )) : <p className="detail-hint">没有匹配的词卡。</p>
        )}
      </div>
    </div>
  );
}
