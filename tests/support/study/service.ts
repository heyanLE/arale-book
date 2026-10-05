import * as fs from 'node:fs';
import * as path from 'node:path';
import { StudyService as SharedStudyService, type StudyServiceOptions } from '../../../src/core/study/service';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../../../src/core/util/atomic-json';
import { createJlptIndex, type JlptRow } from '../../../src/core/study/jlpt';
import { bookDir } from '../paths';
import { buildAnkiPackage } from './apkg';
import { cropStudyOccurrence, pageStudyOccurrence, sourcePage } from './crop';
import { tokenizeJapanese } from './tokenizer';
import { wordfreqSource, zipfForCandidate } from './wordfreq';
export { chooseMeaning } from '../../../src/core/study/service';
export type { StudyServiceOptions } from '../../../src/core/study/service';
const DATA_FILE = 'jlpt-vocabulary.json';
function loadJlpt(): { index: ReturnType<typeof createJlptIndex>; source: string } {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const filename = path.join(dir, 'data', DATA_FILE);
    if (fs.existsSync(filename)) {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8')) as { revision: string; entries: JlptRow[] };
      return { index: createJlptIndex(data.entries), source: `stephenmk/yomitan-jlpt-vocab@${data.revision}` };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到随包的 JLPT 参考词表');
}


export class StudyService extends SharedStudyService {
  constructor(options: StudyServiceOptions) {
    super(options, {
      readJson, writeJsonAtomic, writeFileAtomic, join: path.join, bookDir,
      mkdir: directory => fs.mkdirSync(directory, { recursive: true }),
      jlpt: loadJlpt, wordfreqSource, zipfForCandidate, tokenizeJapanese,
      yield: () => new Promise(resolve => setImmediate(resolve)),
      crop: cropStudyOccurrence, pageImage: pageStudyOccurrence,
      validateSource: sourcePage, buildPackage: buildAnkiPackage,
    });
  }
}
