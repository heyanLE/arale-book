/**
 * Yomitan 日语变形还原（deinflection）—— 移植 Fushi `deinflector.cpp` 的算法，
 * 数据用 Yomitan 官方的 `assets/transforms/ja.json`（已复制到 `data/ja-transforms.json`）。
 *
 * 算法容易做错的三处，这里逐一说明：
 * 1. **初始条件是通配**。Fushi 的 `deinflect(text)` 初始 conditions=0，而检查是
 *    `if (conditions != 0 && !(conditions & rule.conditions_in)) continue;`
 *    （deinflector.cpp:270）—— 0 当通配用。这里显式用 `['*']` 表达同一个意思，
 *    避免 0 同时表示「无条件」与「任意条件」这种混淆。
 * 2. **中间状态不能只按文本去重**。`食べました` 的 `食べます` 有两条来路：
 *    `ました→ます`（conditionsOut `-ます`，能继续走到 `ます→る`）与
 *    `した→す`（conditionsOut `v5`，走不到）。若只留一个文本，链条被切断，
 *    `食べました` 就查不到 `食べる`。所以状态去重键是 `文本 + 条件集合`。
 * 3. **子条件要传递展开**：`v` 的 subConditions 含 `v1`/`v5`/`vk`/`vs`/`vz`，
 *    而 `v5` 又含 `v5d`/`v5s`…… 不展开的话五段动词一律还原不出来。
 *    Fushi 用位图 + 定点迭代展开（deinflector.cpp:144-166），这里用字符串闭包。
 *
 * 与 Fushi 的有意差异：Fushi 里 `conditionsOut: []` 会退化成 0，于是又变成通配，
 * 关中方言规则链因此能继续往下走。这里按 Yomitan 的字面语义处理：空条件集合就是
 * 「没有可用条件」，链在此终止（ja.json 里只有 kansai-ben 的 30 条空 conditionsOut 规则受影响）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DeinflectionStep } from '../../shared/types';

/** 规则种类。ja.json 里只有 suffix(826) 与 wholeWord(8)。 */
export interface DeinflectionRule {
  /**
   * 规则种类。`wholeWord` 在解析时被规范化成 `type:'suffix'` + `wholeWord:true`，
   * 于是 `fromSuffix`/`toSuffix` 始终是有效字段；`prefix` 规则 v1 不支持（见 parseTransformFile）。
   */
  type: 'suffix';
  fromSuffix: string;
  toSuffix: string;
  conditionsIn: string[];
  conditionsOut: string[];
  /** Yomitan 的 wholeWord 规则：整词完全等于 fromSuffix 才生效（如 いらっしゃいます→いらっしゃる）。 */
  wholeWord?: boolean;
}

export interface DeinflectionTransform {
  name: string;
  description: string;
  rules: DeinflectionRule[];
}

export interface TransformCondition {
  name: string;
  isDictionaryForm: boolean;
  subConditions?: string[];
}

export interface TransformFile {
  language: string;
  conditions: Record<string, TransformCondition>;
  transforms: Record<string, DeinflectionTransform>;
}

/** 一次还原的候选：文本、还原轨迹、该状态的条件集合。 */
export interface DeinflectionCandidate {
  text: string;
  trace: DeinflectionStep[];
  conditions: string[];
}

const WILDCARD = '*';

/** Fushi `deinflector.hpp` 的 kMaxRecursionDepth = 10，即最多 10 次规则应用。 */
export const MAX_DEINFLECTION_DEPTH = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`transforms JSON: ${where} 必须是字符串`);
  return value;
}

function requireStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`transforms JSON: ${where} 必须是字符串数组`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`transforms JSON: ${where} 含非字符串项`);
    out.push(item);
  }
  return out;
}

/**
 * 校验并规范化一份 transforms JSON，形状不对直接抛（宁可启动时炸，也不要静默地
 * 退化成「永远查不到变形词」这种看不见的故障）。
 *
 * 规范化规则：
 * - `type:'suffix'` 原样保留；
 * - `type:'wholeWord'`（ja.json 有 8 条，都是 いらっしゃいます→いらっしゃる 这类敬语）
 *   压成 `type:'suffix'` + `wholeWord:true`，`from`/`to` 落到 `fromSuffix`/`toSuffix`；
 * - `type:'prefix'` v1 跳过并计数（日语用不到；跳过而不是抛，免得换个语言的
 *   transforms 文件直接让程序起不来）。
 */
export function parseTransformFile(data: unknown): TransformFile {
  if (!isRecord(data)) throw new Error('transforms JSON: 顶层必须是对象');
  const language = requireString(data['language'], 'language');
  if (!isRecord(data['conditions'])) throw new Error('transforms JSON: conditions 必须是对象');
  if (!isRecord(data['transforms'])) throw new Error('transforms JSON: transforms 必须是对象');

  const conditions: Record<string, TransformCondition> = {};
  for (const [key, raw] of Object.entries(data['conditions'])) {
    if (!isRecord(raw)) throw new Error(`transforms JSON: conditions.${key} 必须是对象`);
    const condition: TransformCondition = {
      name: requireString(raw['name'], `conditions.${key}.name`),
      isDictionaryForm: raw['isDictionaryForm'] === true,
    };
    if (raw['subConditions'] !== undefined) {
      condition.subConditions = requireStringArray(raw['subConditions'], `conditions.${key}.subConditions`);
    }
    conditions[key] = condition;
  }

  let skippedPrefixRules = 0;
  const transforms: Record<string, DeinflectionTransform> = {};
  for (const [key, raw] of Object.entries(data['transforms'])) {
    if (!isRecord(raw)) throw new Error(`transforms JSON: transforms.${key} 必须是对象`);
    if (!Array.isArray(raw['rules'])) throw new Error(`transforms JSON: transforms.${key}.rules 必须是数组`);
    const rules: DeinflectionRule[] = [];
    for (let i = 0; i < raw['rules'].length; i += 1) {
      const rule = raw['rules'][i];
      const where = `transforms.${key}.rules[${i}]`;
      if (!isRecord(rule)) throw new Error(`transforms JSON: ${where} 必须是对象`);
      const type = requireString(rule['type'], `${where}.type`);
      const conditionsIn = rule['conditionsIn'] === undefined ? [] : requireStringArray(rule['conditionsIn'], `${where}.conditionsIn`);
      const conditionsOut = rule['conditionsOut'] === undefined ? [] : requireStringArray(rule['conditionsOut'], `${where}.conditionsOut`);
      if (type === 'suffix') {
        rules.push({
          type: 'suffix',
          fromSuffix: requireString(rule['fromSuffix'], `${where}.fromSuffix`),
          toSuffix: requireString(rule['toSuffix'], `${where}.toSuffix`),
          conditionsIn,
          conditionsOut,
        });
      } else if (type === 'wholeWord') {
        rules.push({
          type: 'suffix',
          fromSuffix: requireString(rule['from'], `${where}.from`),
          toSuffix: requireString(rule['to'], `${where}.to`),
          conditionsIn,
          conditionsOut,
          wholeWord: true,
        });
      } else if (type === 'prefix') {
        skippedPrefixRules += 1;
      } else {
        throw new Error(`transforms JSON: ${where}.type 未知: ${type}`);
      }
    }
    transforms[key] = {
      name: requireString(raw['name'], `transforms.${key}.name`),
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      rules,
    };
  }
  if (skippedPrefixRules > 0) {
    // 中文注释：v1 只吃日语；prefix 规则出现在别的语言里，跳过而不是炸。
    console.warn(`[dict] transforms ${language}: 跳过 ${skippedPrefixRules} 条 prefix 规则（v1 不支持）`);
  }

  return { language, conditions, transforms };
}

/**
 * 找到随包分发的 `data/ja-transforms.json`。
 *
 * 编译产物可能在 `<root>/dist/core/dict/`（主进程）或 `<root>/dist-test/src/core/dict/`
 * （测试），两者到仓库根的层数不同，所以逐级向上找，而不是写死 `../../`。
 * 打包/换布局时可用 `ARALE_JA_TRANSFORMS` 指定绝对路径覆盖。
 */
function resolveTransformsPath(): string {
  const override = process.env.ARALE_JA_TRANSFORMS;
  if (override && fs.existsSync(override)) return override;
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'data', 'ja-transforms.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = path.join(process.cwd(), 'data', 'ja-transforms.json');
  if (fs.existsSync(fromCwd)) return fromCwd;
  throw new Error('找不到 data/ja-transforms.json；可用 ARALE_JA_TRANSFORMS 指定绝对路径');
}

/** 随包分发的日语变形数据（54 transforms / 22 conditions / 834 rules）。 */
export const jaTransforms: TransformFile = parseTransformFile(
  JSON.parse(fs.readFileSync(resolveTransformsPath(), 'utf8')) as unknown,
);

// ---------------------------------------------------------------------------
// 编译：条件闭包 + 扁平规则表（按 TransformFile 缓存）
// ---------------------------------------------------------------------------

interface CompiledRule {
  name: string;
  description: string;
  fromSuffix: string;
  toSuffix: string;
  wholeWord: boolean;
  /** conditionsIn 里所有条件名的传递闭包（含自身）。空集 = 只有通配状态能触发。 */
  inClosure: Set<string>;
  conditionsOut: string[];
}

interface CompiledTransforms {
  rules: CompiledRule[];
}

const compiledCache = new WeakMap<TransformFile, CompiledTransforms>();

function compile(transforms: TransformFile): CompiledTransforms {
  const cached = compiledCache.get(transforms);
  if (cached) return cached;

  const closureCache = new Map<string, Set<string>>();
  const closureOf = (name: string): Set<string> => {
    const cachedClosure = closureCache.get(name);
    if (cachedClosure) return cachedClosure;
    const set = new Set<string>();
    const stack = [name];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (set.has(current)) continue; // 防子条件环
      set.add(current);
      const condition = transforms.conditions[current];
      for (const sub of condition?.subConditions ?? []) stack.push(sub);
    }
    closureCache.set(name, set);
    return set;
  };

  const rules: CompiledRule[] = [];
  for (const transform of Object.values(transforms.transforms)) {
    for (const rule of transform.rules) {
      const inClosure = new Set<string>();
      for (const name of rule.conditionsIn) for (const item of closureOf(name)) inClosure.add(item);
      rules.push({
        name: transform.name,
        description: transform.description,
        fromSuffix: rule.fromSuffix,
        toSuffix: rule.toSuffix,
        wholeWord: rule.wholeWord === true,
        inClosure,
        conditionsOut: rule.conditionsOut,
      });
    }
  }

  const compiled: CompiledTransforms = { rules };
  compiledCache.set(transforms, compiled);
  return compiled;
}

/** 状态条件是否满足规则的 conditionsIn：通配放行，否则要求闭包交集非空。 */
function satisfies(stateConditions: readonly string[], rule: CompiledRule): boolean {
  if (stateConditions.includes(WILDCARD)) return true;
  for (const condition of stateConditions) {
    if (rule.inClosure.has(condition)) return true;
  }
  return false;
}

interface State {
  text: string;
  trace: DeinflectionStep[];
  conditions: string[];
}

/** 轨迹只用于 tie-break，保证同一输入的输出顺序逐字节稳定。 */
function traceKey(trace: readonly DeinflectionStep[]): string {
  return trace.map((step) => step.name).join('\u0000');
}

const resultCache = new WeakMap<TransformFile, Map<string, DeinflectionCandidate[]>>();
const RESULT_CACHE_LIMIT = 4096;

/**
 * 对一个词做变形还原。返回所有可达词形（含原词本身，轨迹为空），按 `text` 排序。
 *
 * @param transforms 变形数据；默认随包的日语数据。注入式参数让测试不必碰磁盘。
 * @param maxDepth 最多应用多少次规则，默认 10（Fushi 的 kMaxRecursionDepth）。
 */
export function deinflect(
  word: string,
  transforms: TransformFile = jaTransforms,
  maxDepth: number = MAX_DEINFLECTION_DEPTH,
): DeinflectionCandidate[] {
  if (word.length === 0 || maxDepth < 0) return [];

  let cache = resultCache.get(transforms);
  if (!cache) {
    cache = new Map<string, DeinflectionCandidate[]>();
    resultCache.set(transforms, cache);
  }
  const cacheKey = `${maxDepth}\u0000${word}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { rules } = compile(transforms);
  const best = new Map<string, DeinflectionCandidate>();
  const consider = (candidate: DeinflectionCandidate): void => {
    const existing = best.get(candidate.text);
    if (existing === undefined) {
      best.set(candidate.text, candidate);
      return;
    }
    // 步数少者胜（= 直接命中/短路径优先）；步数相同用轨迹名做确定性 tie-break。
    if (candidate.trace.length < existing.trace.length) {
      best.set(candidate.text, candidate);
    } else if (candidate.trace.length === existing.trace.length && traceKey(candidate.trace) < traceKey(existing.trace)) {
      best.set(candidate.text, candidate);
    }
  };

  const origin: State = { text: word, trace: [], conditions: [WILDCARD] };
  consider(origin);
  let frontier: State[] = [origin];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: State[] = [];
    // 同层去重键 = 文本 + 条件集合：只按文本去重会切断 ます→る 这类链条（见文件头注释 2）。
    const seen = new Set<string>();
    for (const state of frontier) {
      for (const rule of rules) {
        if (rule.wholeWord) {
          if (state.text !== rule.fromSuffix) continue;
        } else if (!state.text.endsWith(rule.fromSuffix)) {
          continue;
        }
        if (!satisfies(state.conditions, rule)) continue;
        const text = state.text.slice(0, state.text.length - rule.fromSuffix.length) + rule.toSuffix;
        if (text === state.text) continue; // 空变换，防自环
        const conditions = rule.conditionsOut;
        const key = `${text}\u0000${[...conditions].sort().join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const trace = [...state.trace, { name: rule.name, description: rule.description }];
        next.push({ text, trace, conditions });
        consider({ text, trace, conditions });
      }
    }
    frontier = next;
  }

  const out = [...best.values()]
    .filter((candidate) => candidate.text.length > 0)
    .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  if (cache.size >= RESULT_CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, out);
  return out;
}
