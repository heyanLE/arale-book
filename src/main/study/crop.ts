/** 从原漫画页的 OCR 文字矩形裁图；词级偏移不能冒充像素级框。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { StudyOccurrence, TextBlock } from '../../shared/types';
import { parseMangaJson } from '../../core/comic/mokuro';
import { resolveInside } from '../../core/util/paths';
import { bookContentDir } from '../paths';

export interface StudyCrop { name: string; data: Buffer; }

/** 测试可直接验证边界；OCR box 是原图像素，不按屏幕缩放比转换。 */
export function cropRect(box: TextBlock['box'], width: number, height: number): { x: number; y: number; width: number; height: number } {
  const padding = Math.max(8, Math.round(Math.min(width, height) * 0.004));
  const x1 = Math.max(0, Math.floor(box[0] - padding));
  const y1 = Math.max(0, Math.floor(box[1] - padding));
  const x2 = Math.min(width, Math.ceil(box[2] + padding));
  const y2 = Math.min(height, Math.ceil(box[3] + padding));
  if (!Number.isFinite(x1 + y1 + x2 + y2) || x2 <= x1 || y2 <= y1) throw new Error('漫画文字框坐标无效，无法裁图');
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function cropStudyOccurrence(bookId: string, occurrence: StudyOccurrence): StudyCrop {
  if (!occurrence.ref.startsWith('page:')) throw new Error('这条候选没有漫画页出处');
  const split = occurrence.ref.lastIndexOf('#');
  const pageUrl = occurrence.ref.slice(5, split);
  const blockIndex = Number(occurrence.ref.slice(split + 1));
  if (split <= 5 || !Number.isSafeInteger(blockIndex) || blockIndex < 0) throw new Error('漫画出处格式无效');
  const root = bookContentDir(bookId);
  const manga = path.join(root, 'manga.json');
  if (!fs.existsSync(manga)) throw new Error('缺少漫画文字层，无法定位原图');
  const page = parseMangaJson(fs.readFileSync(manga, 'utf8')).find((item) => item.url === pageUrl);
  const block = page?.blocks[blockIndex];
  if (!page || !block) throw new Error('原文文字框已变化，请重新生成学习候选');
  if (block.lines.join('') !== occurrence.text) throw new Error('原文已变化，请重新生成学习候选');
  const imagePath = resolveInside(root, pageUrl);
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('找不到漫画原始页图');
  // 延迟加载 Electron，纯 Node 的分词/词卡单测不需要 Electron 进程。
  const { nativeImage } = require('electron') as typeof import('electron');
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error('原图无法解码；当前裁图支持 PNG/JPEG，请换页图格式后重试');
  const size = image.getSize();
  const rect = cropRect(block.box, size.width, size.height);
  let cropped = image.crop(rect);
  const maxSide = Math.max(rect.width, rect.height);
  if (maxSide > 1600) cropped = cropped.resize({ width: Math.round(rect.width * 1600 / maxSide), height: Math.round(rect.height * 1600 / maxSide) });
  const data = cropped.toPNG();
  if (data.length === 0) throw new Error('漫画裁图为空');
  const name = `aralebook_${createHash('sha256').update(data).digest('hex').slice(0, 24)}.png`;
  return { name, data };
}
