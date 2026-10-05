import { buildAnkiPackage as sharedPackage, type CardInput } from '../../../src/core/study/apkg';
import type { StudyCardTier } from '../../../src/shared/types';
export async function buildAnkiPackage(bookId:string,bookTitle:string,tier:StudyCardTier,inputs:readonly CardInput[]):Promise<Buffer> {
 const initSqlJs = require('sql.js/dist/sql-asm-memory-growth.js') as typeof import('sql.js');
 return Buffer.from(await sharedPackage(bookId,bookTitle,tier,inputs,initSqlJs));
}
