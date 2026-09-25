/**
 * **词卡弹窗**：点击或划词之后弹出的那一张卡。
 *
 * ## 与旧版的区别（以及为什么）
 *
 * 旧版是一个「只读的释义弹窗」。现在它是一张**可以留下来、可以改、可以再加工**的卡：
 * 顶部的词能手动改、能 pin 住不被点走、能存进这本书的词卡夹、能让 LLM 再分析一遍。
 *
 * ## 三个必须做对的点
 *
 * 1. **`setPointerCapture` 会吃掉表头里按钮的 click**。旧版的 × 点了没反应，根因就是
 *    表头的 `onPointerDown` 无条件 `setPointerCapture`：指针被表头捕获后 `pointerup`
 *    的目标也变成表头，于是浏览器把 `click` 派发到**表头**而不是按钮，按钮的 onClick
 *    永远不触发。修法是在 `pointerdown` 里判断「起点是不是落在按钮上」，是就不开始拖动。
 *    A− / A+ 之前同样点不动，一起修好了。
 *
 * 2. **释义 HTML 走 `dangerouslySetInnerHTML`** —— 信任边界在**主进程**（glossary 已经在
 *    那边 sanitize 过）。这里不再二次转义，否则 `<ul>/<li>/<ruby>` 会变成字面量。
 *    **LLM 返回的文本不走 innerHTML**，它是模型生成的，用纯文本渲染。
 *
 * 3. **顶部词与词典词是两个字段**。点击查词允许「猜」，划词是用户明确框住的，不许再猜。
 *    所以 `word` 是可编辑的卡片标题，`dictionaryExpression` 是词典里的辞书形，两者
 *    可以不同（用户划了「食べました」，词典里是「食べる」）。详见 shared/types.ts 的 WordCard。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
// 只用于类型标注（React.PointerEvent），`import type` 保证运行时零残留。
import type * as React from 'react';
import type {
  GlossaryContent,
  GlossaryStructured,
  LlmProfile,
  LookupResult,
  LookupTermResult,
  WordCardAnalysis,
} from '@shared/types';
import { hasAnalysisFor } from '@core/cards/analyses';
import { capturePointer } from '../lib/pointer';

export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 词典命中来源（用于切换）。 */
interface DictionaryTab {
  id: string;
  title: string;
}

export interface WordCardPopupProps {
  /** 这张卡在父级弹窗列表里的下标，用于错开叠放。 */
  cascade: number;
  /** 顶部显示的词（可编辑）。 */
  word: string;
  /** 词典查询结果；null = 没查到（划词时可能出现）。 */
  result: LookupResult | null;
  anchor: AnchorRect;
  pinned: boolean;
  /** 当前选中的词典 id；null = 跟随最佳命中。 */
  dictionaryId: string | null;
  /** 是不是已经存进词卡夹了。 */
  saved: boolean;
  /** 保存/更新中。 */
  saving: boolean;
  /** 这张卡上的所有 LLM 分析（短词在前）。 */
  analyses: WordCardAnalysis[];
  /** 正在分析哪个词；null = 空闲。 */
  analyzingWord: string | null;
  /** 这张卡临时指定的 LLM 配置；null = 用设置里的默认。 */
  llmProfileId: string | null;
  /** 可选的 LLM 配置（设置里那几套）。 */
  llmProfiles: LlmProfile[];
  /** 上一次失败的原文。 */
  lastError: string | null;
  onAnalyze: (word: string) => void;
  onRemoveAnalysis: (word: string) => void;
  onSelectLlmProfile: (profileId: string | null) => void;
  onClose: () => void;
  onTogglePin: () => void;
  onWordChange: (word: string) => void;
  onSelectDictionary: (dictionaryId: string) => void;
  onSave: () => void;
  /** 划词查词时用户框住的原文长度（> 0 表示这是一次「精准查询」）。 */
  selectionLength: number;
}

const GAP = 6;
const EDGE = 8;
/** 多个弹窗叠放时的错位量，避免完全重合到看不见下面那张。 */
const CASCADE_STEP = 18;

export function WordCardPopup(props: WordCardPopupProps): JSX.Element {
  const {
    cascade,
    word,
    result,
    anchor,
    pinned,
    dictionaryId,
    saved,
    saving,
    analyses,
    analyzingWord,
    llmProfileId,
    llmProfiles,
    lastError,
    onAnalyze,
    onRemoveAnalysis,
    onSelectLlmProfile,
    onClose,
    onTogglePin,
    onWordChange,
    onSelectDictionary,
    onSave,
    selectionLength,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [wordDraft, setWordDraft] = useState(word);
  const [editingWord, setEditingWord] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  /** 用户手动拖动过之后就别再自动定位了。 */
  const manualRef = useRef(false);
  const wordInputRef = useRef<HTMLInputElement>(null);

  // 外部改了词（例如从词卡夹里打开某张卡）就同步到输入框。
  useEffect(() => {
    setWordDraft(word);
  }, [word]);

  useEffect(() => {
    if (editingWord) wordInputRef.current?.select();
  }, [editingWord]);

  // 先按「锚点下方」渲染一帧量尺寸，再决定是否翻转。
  useLayoutEffect(() => {
    if (manualRef.current) return;
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    let left = anchor.x;
    if (left + width > window.innerWidth - EDGE) {
      left = anchor.x + anchor.width - width;
    }
    left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));

    let top = anchor.y + anchor.height + GAP;
    if (top + height > window.innerHeight - EDGE) {
      const above = anchor.y - height - GAP;
      top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - height - EDGE);
    }

    // 多张卡叠放时按序错开；叠满一轮就绕回来，不让它越堆越偏。
    const shift = (cascade % 6) * CASCADE_STEP;
    setPos({
      left: Math.max(EDGE, Math.min(left + shift, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(top + shift, window.innerHeight - height - EDGE)),
    });
  }, [anchor, cascade, result]);

  // Esc 关闭。捕获阶段监听，避免被阅读器自己的键盘处理先吃掉。
  // **pinned 的卡不响应 Esc** —— 它存在的意义就是「别自己消失」。
  useEffect(() => {
    if (pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, pinned]);

  // 点击外部关闭。pinned 不关。
  useEffect(() => {
    if (pinned) return;
    const onMouseDown = (event: MouseEvent) => {
      const el = ref.current;
      const target = event.target;
      // `event.target` 不一定是 Node（在 window/document 上派发的事件就是），
      // 直接 contains(target) 会抛 TypeError 把整个监听器打挂——一旦挂掉，
      // 「点外部关闭」就永久失效，而且用户只会在控制台看到一句莫名的类型错误。
      if (el !== null && target instanceof Node && el.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose, pinned]);

  const onHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // ★ 这一行就是「叉叉点了没反应」的修复。见文件头第 1 条。
    // 判据用 closest('button')：以后往表头里加任何按钮（pin、保存、词卡夹）都自动生效，
    // 不需要记得在每个按钮上再写一遍 stopPropagation。
    if ((event.target as HTMLElement).closest('button, input')) return;
    const el = ref.current;
    if (!el) return;
    dragRef.current = { dx: event.clientX - el.offsetLeft, dy: event.clientY - el.offsetTop };
    capturePointer(event.currentTarget, event.pointerId);
  }, []);

  const onHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    manualRef.current = true;
    setPos({
      left: Math.max(0, Math.min(event.clientX - drag.dx, window.innerWidth - 80)),
      top: Math.max(0, Math.min(event.clientY - drag.dy, window.innerHeight - 24)),
    });
  }, []);

  const onHeaderPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const commitWord = useCallback(() => {
    setEditingWord(false);
    const next = wordDraft.trim();
    // 空词不接受：一张没有标题的卡在列表里没法认，也没法拿去查词。
    if (next !== '' && next !== word) onWordChange(next);
    else setWordDraft(word);
  }, [onWordChange, word, wordDraft]);

  const dictionaries = useMemo<DictionaryTab[]>(() => {
    if (result === null) return [];
    const seen = new Map<string, string>();
    for (const entry of result.results) {
      const id = entry.term.dictionaryId;
      if (!seen.has(id)) seen.set(id, entry.term.dictionaryTitle);
    }
    return [...seen].map(([id, title]) => ({ id, title }));
  }, [result]);

  const activeDictionaryId = dictionaryId ?? dictionaries[0]?.id ?? null;
  const entries = useMemo(
    () =>
      (result?.results ?? []).filter(
        (entry) => activeDictionaryId === null || entry.term.dictionaryId === activeDictionaryId,
      ),
    [result, activeDictionaryId],
  );

  const noDictionary = result !== null && result.dictionaryCount === 0;
  const noResult = result !== null && result.results.length === 0;

  return (
    <div
      ref={ref}
      className={`dict-popup wordcard${pinned ? ' is-pinned' : ''}`}
      style={{
        left: pos?.left ?? anchor.x,
        top: pos?.top ?? anchor.y + anchor.height + GAP,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label="词卡"
    >
      {/* ---------- 表头：词（可编辑） + 固定/保存/词卡夹/字号/关闭 ---------- */}
      <div
        className="dict-popup-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        title="拖动可移动卡片"
      >
        {editingWord ? (
          <input
            ref={wordInputRef}
            className="wordcard-word-input"
            value={wordDraft}
            onChange={(event) => setWordDraft(event.target.value)}
            onBlur={commitWord}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitWord();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setWordDraft(word);
                setEditingWord(false);
              }
            }}
          />
        ) : (
          <>
            <button
              type="button"
              className="wordcard-word"
              onClick={() => setEditingWord(true)}
              title="点一下可以改这个词"
            >
              {word !== '' ? word : '（无词）'}
            </button>
            {/* 光靠「标题能点」没有任何提示——用户不会去点标题。给一个显式的编辑按钮。 */}
            <button
              type="button"
              className="icon-btn wordcard-edit"
              onClick={() => setEditingWord(true)}
              title="编辑这个词"
              aria-label="编辑这个词"
            >
              ✎
            </button>
          </>
        )}

        {selectionLength > 0 && (
          <span className="wordcard-mode" title="这是划词查询：按你框住的原文精确查的">
            划词
          </span>
        )}

        <span className="dict-popup-spacer" />

        <button
          type="button"
          className={`icon-btn${pinned ? ' is-active' : ''}`}
          onClick={onTogglePin}
          title={pinned ? '取消固定（之后点别处会关闭）' : '固定：点别处也不会关闭，可以同时开多张'}
        >
          {pinned ? '📌' : '📍'}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setScale((s) => Math.max(0.75, s - 0.125))}
          title="缩小字号"
        >
          A−
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setScale((s) => Math.min(2, s + 0.125))}
          title="放大字号"
        >
          A+
        </button>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          ×
        </button>
      </div>

      <div className="dict-popup-body" style={{ fontSize: `${Math.round(13 * scale)}px` }}>
        {/* ---------- 第一栏：词典释义 ---------- */}
        {noDictionary ? (
          <div className="dict-empty">
            <div className="dict-empty-title">未安装词典</div>
            <div className="dict-empty-hint">打开「设置 → 词典」导入 Yamanote 格式的词典包（zip）。</div>
          </div>
        ) : noResult ? (
          <div className="dict-empty">
            <div className="dict-empty-title">未找到释义</div>
            <div className="dict-empty-hint">
              查询词：<span className="mono">{word}</span>
            </div>
          </div>
        ) : (
          <>
            {dictionaries.length > 1 && (
              <div className="wordcard-dicts" role="tablist" aria-label="词典">
                {dictionaries.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={tab.id === activeDictionaryId}
                    className={`wordcard-dict-tab${tab.id === activeDictionaryId ? ' is-active' : ''}`}
                    onClick={() => onSelectDictionary(tab.id)}
                    title={tab.title}
                  >
                    {tab.title}
                  </button>
                ))}
              </div>
            )}
            {entries.map((entry, index) => (
              <TermSection
                key={`${entry.term.dictionaryId}-${entry.term.sequence}-${index}`}
                entry={entry}
                showDictionary={dictionaries.length <= 1}
              />
            ))}
          </>
        )}

        {/* ---------- 第二栏起：LLM 分析（一个分析过的词一栏） ----------
            用户会从短划到长：先划 A 分析，再划 AB。所以这里把「当前词包含的所有
            已分析过的词」一栏栏列出来（短的在前），最后是当前词自己的那一栏。 */}
        <section className="wordcard-llm">
          <div className="wordcard-llm-head">
            <span className="wordcard-llm-title">LLM 分析</span>
            <span className="dict-popup-spacer" />
            {llmProfiles.length > 1 && (
              <select
                className="select select-sm"
                value={llmProfileId ?? ''}
                onChange={(e) => onSelectLlmProfile(e.target.value === '' ? null : e.target.value)}
                title="这次用哪套 LLM 配置"
              >
                <option value="">默认配置</option>
                {llmProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {analyses.map((analysis) => (
            <div className="wordcard-llm-item" key={analysis.word}>
              <div className="wordcard-llm-item-head">
                <span className="wordcard-llm-word">{analysis.word || '（整张卡）'}</span>
                <span className="dict-popup-spacer" />
                <span className="wordcard-llm-meta mono">
                  {analysis.profileName}
                  {analysis.model !== '' ? ` · ${analysis.model}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={analyzingWord !== null}
                  onClick={() => onAnalyze(analysis.word)}
                  title="重新问一次模型"
                >
                  重新分析
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onRemoveAnalysis(analysis.word)}
                  title="删掉这一栏"
                >
                  ×
                </button>
              </div>
              {/* 模型输出是纯文本，**不走 innerHTML**（它是生成内容，不是我们 sanitize 过的词典 HTML）。 */}
              <div className="wordcard-llm-text">{analysis.text}</div>
            </div>
          ))}

          {/* 当前词自己的那一栏：已经有结果就不重复显示（上面那条就是它），
              否则给一个「分析」入口。 */}
          {!hasAnalysisFor(analyses, word) && (
            <div className="wordcard-llm-item is-new">
              <div className="wordcard-llm-item-head">
                <span className="wordcard-llm-word">{word || '（整张卡）'}</span>
                <span className="dict-popup-spacer" />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={analyzingWord !== null}
                  onClick={() => onAnalyze(word)}
                  title="把这张卡的词交给设置里配置的 LLM 分析"
                >
                  {analyzingWord === word ? '分析中…' : '分析'}
                </button>
              </div>
              {analyzingWord === word && (
                <div className="wordcard-llm-hint">正在等模型返回…</div>
              )}
            </div>
          )}

          {lastError !== null && <div className="wordcard-llm-error">{lastError}</div>}
        </section>

        {/* ---------- 底栏：保存 ---------- */}
        <div className="wordcard-actions">
          <button
            type="button"
            className={`btn btn-sm${saved ? '' : ' btn-primary'}`}
            disabled={saving}
            onClick={onSave}
            title={saved ? '已保存在本书的词卡夹里；再点一次会更新它' : '保存到本书的词卡夹'}
          >
            {saving ? '保存中…' : saved ? '已保存 ✓' : '保存到词卡'}
          </button>
          <span className="dict-popup-spacer" />
          <span className="wordcard-count mono">
            {result !== null && !noResult && !noDictionary
              ? `${entries.length} 条 · ${dictionaries.length} 部词典`
              : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

function TermSection({
  entry,
  showDictionary,
}: {
  entry: LookupTermResult;
  showDictionary: boolean;
}): JSX.Element {
  const term = entry.term;

  // 变形还原轨迹：食べました ← ます形 ← 食べる
  const chain: string[] = [];
  const push = (value: string) => {
    if (value === '' || chain.includes(value)) return;
    chain.push(value);
  };
  push(entry.matched);
  for (const step of entry.deinflection) push(step.description !== '' ? step.description : step.name);
  push(term.expression);

  return (
    <section className="dict-section">
      <div className="dict-term-head">
        <span className="dict-expression">{term.expression}</span>
        {term.reading !== '' && <span className="dict-reading">{term.reading}</span>}
        <span className="dict-popup-spacer" />
        {/* 单部词典时也把来源标出来：「这词是哪来的」是查词时最基本的信息。 */}
        {showDictionary && (
          <span className="dict-dict-title" title={term.dictionaryTitle}>
            {term.dictionaryTitle}
          </span>
        )}
      </div>

      {(term.definitionTags.length > 0 || term.termTags.length > 0) && (
        <div className="dict-tags">
          {term.termTags.map((tag) => (
            <span key={`t-${tag}`} className="dict-tag">
              {tag}
            </span>
          ))}
          {term.definitionTags.map((tag) => (
            <span key={`d-${tag}`} className="dict-tag dict-tag-def">
              {tag}
            </span>
          ))}
        </div>
      )}

      {entry.frequencies.length > 0 && (
        <div className="dict-freqs">
          {entry.frequencies.map((freq, index) => (
            <span key={`${freq.dictionary}-${index}`} className="dict-freq" title={freq.dictionary}>
              {freq.dictionary}：{freq.display !== null ? freq.display : String(freq.value)}
            </span>
          ))}
        </div>
      )}

      {chain.length > 1 && (
        <div className="dict-deinflect" title="变形还原轨迹">
          {chain.join(' ← ')}
        </div>
      )}

      {/*
        信任边界在主进程：glossary 里的 HTML 已经过 sanitize 才通过 IPC 过来。
        这里**故意**再插一次 innerHTML —— 见文件头第 2 条。
      */}
      <div
        className="dict-glossary"
        dangerouslySetInnerHTML={{ __html: glossaryToHtml(term.glossary) }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Yomitan 结构化内容 → HTML
// ---------------------------------------------------------------------------

/** 允许透出的标签白名单。glossary 里出现别的（例如 img/iframe/script）一律降级成 span。 */
const ALLOWED_TAGS = new Set([
  'span',
  'div',
  'p',
  'ul',
  'ol',
  'li',
  'br',
  'ruby',
  'rt',
  'rp',
  'b',
  'i',
  'em',
  'strong',
  'u',
  's',
  'small',
  'sup',
  'sub',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
]);

const VOID_TAGS = new Set(['br']);

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case '<':
        return '&lt;';
      default:
        return '&gt;';
    }
  });
}

function styleToAttribute(style: Record<string, string> | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (typeof value !== 'string') continue;
    // 样式值里塞 url()/expression 是经典的 CSS 注入面；Yomitan 正常不会用，直接丢。
    if (/url\s*\(|expression\s*\(|javascript:/i.test(value)) continue;
    parts.push(`${key}:${escapeAttribute(value)}`);
  }
  return parts.length > 0 ? ` style="${parts.join(';')}"` : '';
}

function glossaryToHtml(content: GlossaryContent): string {
  if (typeof content === 'string') {
    // 字符串部分本身就是（已被主进程 sanitize 的）HTML 片段。
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(glossaryToHtml).join('');
  }
  return structuredToHtml(content);
}

function structuredToHtml(node: GlossaryStructured): string {
  const rawTag = typeof node.tag === 'string' ? node.tag.toLowerCase() : '';
  const tag = ALLOWED_TAGS.has(rawTag) ? rawTag : 'span';
  const attrs = styleToAttribute(node.style);
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs} />`;
  return `<${tag}${attrs}>${glossaryToHtml(node.content)}</${tag}>`;
}
