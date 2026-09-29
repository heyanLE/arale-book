/** 直接筛选按数据证据分层；每层给出剩余数，避免“勾了却不知道删了谁”。 */
import type { DirectFilterOptions } from '@shared/types';
import { defaultDirectOptions, type DirectFilterStage } from '@core/study/harness';

export interface DirectFilterPanelProps {
  levels: readonly number[];
  includeUnknown: boolean;
  options: DirectFilterOptions;
  excludedWordsText: string;
  wordfreqSource: string | null;
  stages: readonly DirectFilterStage[];
  selectedCount: number;
  disabled: boolean;
  dirty: boolean;
  checkpointCount: number;
  onLevels: (levels: number[]) => void;
  onIncludeUnknown: (value: boolean) => void;
  onOptions: (options: DirectFilterOptions) => void;
  onExcludedWordsText: (value: string) => void;
  onApply: () => void;
}

export function DirectFilterPanel(props: DirectFilterPanelProps): JSX.Element {
  const { levels, includeUnknown, options, excludedWordsText, wordfreqSource, stages, selectedCount,
    disabled, dirty, checkpointCount, onLevels, onIncludeUnknown, onOptions, onExcludedWordsText, onApply } = props;
  const update = (patch: Partial<DirectFilterOptions>): void => onOptions({ ...options, ...patch });

  return <section className="study-workflow-step study-workflow-direct">
    <h3>1. 直接筛选 · {selectedCount} 个候选</h3>
    <p>从左到右依次应用。新增规则默认关闭；每层的排除数量可先预览，再点击应用。</p>
    <div className="study-workflow-controls study-direct-apply">
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={onApply}>{dirty ? '应用这套直接筛选' : '重新应用直接筛选'}</button>
      <small>“手动保留”可在下方候选详情里设置，并跳过 LLM；明确排除仍优先。</small>
      {checkpointCount > 0 && dirty && <small>已有 {checkpointCount} 个 LLM 检查点；改动规则前需先续跑原设置或放弃检查点。</small>}
    </div>
    <div className="study-workflow-controls">
      <button type="button" className="btn btn-sm" onClick={() => onOptions({
        ...options, partOfSpeech: 'core', excludeProperNames: true, excludeNumbers: true,
        excludeTokenizerUnknown: true, minOccurrences: 2, minZipf: wordfreqSource ? 2.5 : null,
        missingZipf: 'exclude',
      })}>套用报告式严格规则</button>
      <button type="button" className="btn btn-sm" onClick={() => onOptions({ ...defaultDirectOptions(), excludedWords: options.excludedWords })}>关闭词性／次数／词频规则</button>
      <small>{wordfreqSource ? '严格预设会排除词频缺失项；作品专名可在候选详情手动保留。' : '词频数据不可用；预设只启用词性与重复规则。'}</small>
    </div>
    <div className="study-direct-layers">
      <div className="study-direct-layer">
        <strong>① JLPT 参考等级</strong>
        <small>社区参考表；未收录和等级冲突独立选择。</small>
        <div className="study-level-checks">
          {([5, 4, 3, 2, 1] as const).map((value) => <label key={value}><input type="checkbox" checked={levels.includes(value)} onChange={(event) => onLevels(event.target.checked ? [...levels, value] : levels.filter((one) => one !== value))} /> N{value}</label>)}
          <label><input type="checkbox" checked={includeUnknown} onChange={(event) => onIncludeUnknown(event.target.checked)} /> 未分级 / 冲突</label>
        </div>
      </div>
      <details className="study-direct-layer">
        <summary><strong>② 词条类型与噪声{(options.partOfSpeech === 'core' || options.excludeProperNames || options.excludeNumbers || options.excludeTokenizerUnknown || options.excludedWords.length > 0) && ' · 已启用'}</strong>
          <small>词性、专名、数词和作品排除词；旧候选缺细分词性时保留。</small></summary>
        <label>保留词性 <select value={options.partOfSpeech} onChange={(event) => update({ partOfSpeech: event.target.value as DirectFilterOptions['partOfSpeech'] })}>
          <option value="all">全部现有候选</option><option value="core">仅名词 / 动词 / 形容词 / 副词</option>
        </select></label>
        <div className="study-direct-checks">
          <label><input type="checkbox" checked={options.excludeProperNames} onChange={(event) => update({ excludeProperNames: event.target.checked })} /> 排除分词器识别的专名</label>
          <label><input type="checkbox" checked={options.excludeNumbers} onChange={(event) => update({ excludeNumbers: event.target.checked })} /> 排除数词</label>
          <label><input type="checkbox" checked={options.excludeTokenizerUnknown} onChange={(event) => update({ excludeTokenizerUnknown: event.target.checked })} /> 仅保留分词器已知词（严格）</label>
        </div>
        <label>本书排除词 / 人名（每行一个）
          <textarea value={excludedWordsText} onChange={(event) => onExcludedWordsText(event.target.value)} placeholder={'例如：角色名\n重复 OCR 错词'} />
        </label>
      </details>
      <details className="study-direct-layer">
        <summary><strong>③ 作品内重复{options.minOccurrences !== null && ` · 至少 ${options.minOccurrences} 次`}</strong>
          <small>报告参考值为至少 2 次；手动保留可跳过。</small></summary>
        <label><input type="checkbox" checked={options.minOccurrences !== null} onChange={(event) => update({ minOccurrences: event.target.checked ? 2 : null })} /> 启用最低出现次数</label>
        {options.minOccurrences !== null && <label>至少 <input type="number" min="2" max="20" value={options.minOccurrences} onChange={(event) => update({ minOccurrences: Number(event.target.value) })} /> 次</label>}
      </details>
      <details className="study-direct-layer">
        <summary><strong>④ 通用词频 Zipf{options.minZipf !== null && ` · ≥ ${options.minZipf}`}</strong>
          <small>{wordfreqSource ? `${wordfreqSource}；报告参考阈值 2.5。` : '词频数据不可用，暂不能启用。'}</small></summary>
        <label><input type="checkbox" checked={options.minZipf !== null} disabled={!wordfreqSource} onChange={(event) => update({ minZipf: event.target.checked ? 2.5 : null })} /> 启用最低通用词频</label>
        {options.minZipf !== null && <>
          <label>Zipf ≥ <input type="number" min="0" max="8" step="0.1" value={options.minZipf} onChange={(event) => update({ minZipf: Number(event.target.value) })} /></label>
          <label>查不到通用词频 <select value={options.missingZipf} onChange={(event) => update({ missingZipf: event.target.value as DirectFilterOptions['missingZipf'] })}>
            <option value="keep">保留待审（推荐）</option><option value="exclude">排除（严格）</option>
          </select></label>
        </>}
      </details>
    </div>
    <div className="study-direct-result" aria-label="直接筛选各层结果">
      {stages.map((stage) => <span key={stage.name}>{stage.name}：余 {stage.remaining}（排 {stage.removed}）</span>)}
    </div>
  </section>;
}
