import { parseTermRow, parseMetaRow, parseFrequencyData, frequencyKey, type StoredFrequency } from './model';
import { naturalCompare } from '../util/natural-sort';
import type { DictionaryInfo, DictTerm } from '../../shared/types';
import type { DictionaryImportProgress, DictionaryImportResult } from '../../shared/dictionary-imports';

export async function importDictionary(
  native: (channel: string, ...args: unknown[]) => Promise<any>, path: string, taskId: string,
  progress: (value: DictionaryImportProgress) => void,
): Promise<DictionaryImportResult> {
  progress({ stage: 'checking', message: '正在检查词典 ZIP…', done: 0, total: 0, unit: 'files' });
  const staged = await native('dict:stage', path, taskId) as { id: string; title: string; format: number | null; banks: string[] };
  try {
    const warnings: string[] = [];
    if (staged.format !== null && staged.format !== 3) warnings.push(`格式版本为 ${staged.format}，已按 Yomitan v3 解析`);
    const terms: DictTerm[] = [], frequencies = new Map<string, StoredFrequency>();
    let skippedRows = 0, skippedBanks = 0;
    const banks = staged.banks.slice().sort(naturalCompare);
    for (const [i, bank] of banks.entries()) {
      progress({ stage: 'parsing', title: staged.title, message: `正在读取并解析数据文件 ${i + 1}/${banks.length}…`, done: 0, total: 0, unit: 'entries' });
      const raw = await native('dict:rawBank', staged.id, bank) as string;
      let rows: unknown;
      try { rows = JSON.parse(raw); } catch { skippedBanks++; continue; }
      if (!Array.isArray(rows)) { skippedBanks++; continue; }
      const report = (done: number) => progress({ stage: 'parsing', title: staged.title, unit: 'entries', done, total: rows.length,
        message: `解析数据文件 ${i + 1}/${banks.length} · 已读取 ${terms.length} 个词条、${frequencies.size} 项词频` });
      report(0);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (bank.startsWith('term_bank_')) {
          const term = parseTermRow(row, staged.id, staged.title);
          if (term) terms.push(term); else skippedRows++;
        } else {
          const meta = parseMetaRow(row);
          if (!meta) skippedRows++;
          else if (meta.mode === 'freq') {
            const value = parseFrequencyData(meta.data);
            if (!value) skippedRows++;
            else {
              const key = frequencyKey(meta.expression, value.reading);
              let record = frequencies.get(key);
              if (!record) { record = { expression: meta.expression, reading: value.reading, frequencies: [] }; frequencies.set(key, record); }
              record.frequencies.push({ value: value.value, display: value.display, dictionary: staged.title });
            }
          }
        }
        if ((rowIndex + 1) % 2000 === 0) {
          report(rowIndex + 1);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      report(rows.length);
    }
    if (!terms.length && !frequencies.size) throw new Error('没有可导入的词条或词频，请检查词典格式和数据文件');
    if (skippedRows || skippedBanks) warnings.push(`已跳过 ${skippedRows} 条无效数据、${skippedBanks} 个无效数据文件`);
    progress({ stage: 'saving', title: staged.title, message: `正在保存 ${terms.length} 个词条、${frequencies.size} 项词频…`, done: 0, total: 0, unit: 'entries' });
    const dictionary = await native('dict:commit', staged.id, JSON.stringify(terms), JSON.stringify([...frequencies.values()])) as DictionaryInfo;
    return { dictionary, indexed: false, warnings };
  } catch (error) {
    await native('dict:discard', staged.id).catch(() => undefined);
    throw error;
  }
}
