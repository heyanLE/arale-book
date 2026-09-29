/** 规则草稿只改变预览；由父组件明确应用到正式词单。 */
import type { DirectFilterOptions } from '@shared/types';
import { DEFAULT_STUDY_LEVELS, defaultDirectOptions, type DirectFilterStage } from '@core/study/harness';

export interface DirectFilterPanelProps {
  levels: readonly number[];
  includeUnknown: boolean;
  options: DirectFilterOptions;
  excludedWordsText: string;
  wordfreqSource: string | null;
  stages: readonly DirectFilterStage[];
  onLevels: (levels: number[]) => void;
  onIncludeUnknown: (value: boolean) => void;
  onOptions: (options: DirectFilterOptions) => void;
  onExcludedWordsText: (value: string) => void;
}

export function DirectFilterPanel(props: DirectFilterPanelProps): JSX.Element {
  const { levels, includeUnknown, options, excludedWordsText, wordfreqSource, stages,
    onLevels, onIncludeUnknown, onOptions, onExcludedWordsText } = props;
  const update = (patch: Partial<DirectFilterOptions>): void => onOptions({ ...options, ...patch });
  const compact = (): void => {
    onOptions({ ...options, partOfSpeech: 'core', excludeProperNames: true, excludeNumbers: true,
      excludeTokenizerUnknown: false, minOccurrences: 2, minZipf: null, missingZipf: 'keep' });
  };
  const basic = (): void => {
    onLevels([...DEFAULT_STUDY_LEVELS]);
    onIncludeUnknown(false);
    onOptions({ ...defaultDirectOptions(), includeConflict: false, excludedWords: options.excludedWords });
  };
  const conflict = options.includeConflict ?? includeUnknown;
  const removed = (index: number): string => stages[index]?.removed ? `本组新排 ${stages[index]?.removed}` : '本组未新增排除';

  return <div className="study-rule-editor">
    <div className="study-rule-presets" aria-label="规则预设">
      <span>快速设置</span>
      <button type="button" className="btn btn-sm" onClick={basic}>恢复默认等级</button>
      <button type="button" className="btn btn-sm" onClick={compact}>精简候选</button>
      <small>精简候选：保留名/动/形/副，排除专名和数词，且至少出现 2 次；只填入草稿。</small>
    </div>
    <div className="study-rule-groups">
      <section className="study-rule-group">
        <div className="study-rule-group-head"><strong>学哪些等级？</strong><span>{removed(1)}</span></div>
        <p>按社区 JLPT 参考词表选择。N3–N1 是默认范围。</p>
        <div className="study-level-checks">
          {([5, 4, 3, 2, 1] as const).map((value) => <label key={value}><input type="checkbox" checked={levels.includes(value)} onChange={(event) => onLevels(event.target.checked ? [...levels, value] : levels.filter((one) => one !== value))} /> N{value}</label>)}
        </div>
        <div className="study-rule-checks">
          <label><input type="checkbox" checked={includeUnknown} onChange={(event) => {
            if (options.includeConflict == null) update({ includeConflict: conflict });
            onIncludeUnknown(event.target.checked);
          }} /> 未收录等级</label>
          <label><input type="checkbox" checked={conflict} onChange={(event) => update({ includeConflict: event.target.checked })} /> 等级冲突</label>
        </div>
      </section>
      <details className="study-rule-group">
        <summary><strong>排除哪些明显无用词？</strong><span>{removed(2)}</span></summary>
        <p>只排除明确命中的词；旧候选缺少细分信息时会保留，需重新生成候选后再判断。</p>
        <div className="study-rule-checks">
          <label><input type="checkbox" checked={options.excludeProperNames} onChange={(event) => update({ excludeProperNames: event.target.checked })} /> 专名／人名</label>
          <label><input type="checkbox" checked={options.excludeNumbers} onChange={(event) => update({ excludeNumbers: event.target.checked })} /> 数词</label>
          <label><input type="checkbox" checked={options.excludeTokenizerUnknown} onChange={(event) => update({ excludeTokenizerUnknown: event.target.checked })} /> 分词器未知词</label>
        </div>
        <label>保留词性 <select value={options.partOfSpeech} onChange={(event) => update({ partOfSpeech: event.target.value as DirectFilterOptions['partOfSpeech'] })}>
          <option value="all">全部现有候选</option><option value="core">仅名词 / 动词 / 形容词 / 副词</option>
        </select></label>
        <label>本书排除词／人名（每行一个）
          <textarea value={excludedWordsText} onChange={(event) => onExcludedWordsText(event.target.value)} placeholder={'例如：角色名\n重复 OCR 错词'} />
        </label>
      </details>
      <details className="study-rule-group">
        <summary><strong>只保留重复出现的词？</strong><span>{removed(3)}</span></summary>
        <p>单次出现但值得学习的词仍可手动保留。</p>
        <label><input type="checkbox" checked={options.minOccurrences !== null} onChange={(event) => update({ minOccurrences: event.target.checked ? 2 : null })} /> 启用最低出现次数</label>
        {options.minOccurrences !== null && <label>最低次数 <input type="number" min="2" max="20" value={options.minOccurrences} onChange={(event) => update({ minOccurrences: Number(event.target.value) })} /></label>}
      </details>
      <details className="study-rule-group">
        <summary><strong>参考通用词频？</strong><span>{removed(4)}</span></summary>
        <p>Zipf 数字越高，在通用语料中越常见；它不代表漫画词的学习价值或 OCR 正确率。</p>
        <label><input type="checkbox" checked={options.minZipf !== null} disabled={!wordfreqSource} onChange={(event) => update({ minZipf: event.target.checked ? 2.5 : null })} /> 启用最低词频</label>
        {options.minZipf !== null && <>
          <label>Zipf ≥ <input type="number" min="0" max="8" step="0.1" value={options.minZipf} onChange={(event) => update({ minZipf: Number(event.target.value) })} /></label>
          <label>词频未收录 <select value={options.missingZipf} onChange={(event) => update({ missingZipf: event.target.value as DirectFilterOptions['missingZipf'] })}>
            <option value="keep">保留待审</option><option value="exclude">排除</option>
          </select></label>
        </>}
        <small>{wordfreqSource ?? '词频数据不可用'}</small>
      </details>
    </div>
  </div>;
}
