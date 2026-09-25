/**
 * 右侧的**词卡夹**：这本书保存过的所有词卡。
 *
 * 点一条就重新弹出一张词卡（`openCard` 会重查词典，因为词卡不存释义——换词典之后
 * 打开旧卡看到的应该是最新释义，而不是当初那份快照）。
 *
 * 列表按最新在前排：刚存的卡应该在顶上，而不是要翻到底。
 */

import type { WordCard } from '@shared/types';

export interface WordCardPanelProps {
  cards: WordCard[];
  onOpen: (card: WordCard) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

export function WordCardPanel({ cards, onOpen, onRemove, onClose }: WordCardPanelProps): JSX.Element {
  return (
    <aside className="wordcard-panel">
      <div className="wordcard-panel-head">
        <span className="wordcard-panel-title">词卡夹</span>
        <span className="wordcard-panel-count mono">{cards.length}</span>
        <span className="dict-popup-spacer" />
        <button type="button" className="icon-btn" onClick={onClose} title="收起词卡夹">
          ×
        </button>
      </div>

      <div className="wordcard-panel-list">
        {cards.length === 0 ? (
          <div className="detail-hint">
            还没有保存过词卡。查词后点词卡上的「保存到词卡」。
          </div>
        ) : (
          cards.map((card) => (
            <div className="wordcard-item" key={card.id}>
              <button
                type="button"
                className="wordcard-item-main"
                onClick={() => onOpen(card)}
                title="打开这张词卡"
              >
                <span className="wordcard-item-word">{card.word}</span>
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
          ))
        )}
      </div>
    </aside>
  );
}
