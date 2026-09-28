import type { ReadingDirection } from '@shared/types';
import { turnForReaderEdge, type ReaderEdge, type ReaderTurn } from '@shared/reader-navigation';

export interface ReaderEdgeTurnsProps {
  direction: ReadingDirection;
  onBack: () => void;
  onForward: () => void;
  backDisabled: boolean;
  forwardDisabled: boolean;
  unit?: '页' | '章';
}

/** 鼠标移到阅读区左右边缘时出现的翻页热区。 */
export function ReaderEdgeTurns({
  direction,
  onBack,
  onForward,
  backDisabled,
  forwardDisabled,
  unit = '页',
}: ReaderEdgeTurnsProps): JSX.Element {
  const button = (edge: ReaderEdge) => {
    const turn: ReaderTurn = turnForReaderEdge(direction, edge);
    const forward = turn === 'forward';
    const disabled = forward ? forwardDisabled : backDisabled;
    const label = `${edge === 'left' ? '左' : '右'}侧：${forward ? '下一' : '上一'}${unit}`;

    return (
      <button
        type="button"
        className={`reader-edge-turn is-${edge}${disabled ? ' is-disabled' : ''}`}
        aria-disabled={disabled}
        onClick={forward ? onForward : onBack}
        aria-label={label}
        title={label}
        data-turn={turn}
        data-testid={`reader-edge-${edge}`}
      >
        <span aria-hidden="true">{edge === 'left' ? '‹' : '›'}</span>
      </button>
    );
  };

  return (
    <>
      {button('left')}
      {button('right')}
    </>
  );
}
