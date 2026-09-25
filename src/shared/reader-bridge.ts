/**
 * 阅读器桥接协议（冻结文件）。
 *
 * iframe 里跑的那段脚本是本文件底部的 `READER_BRIDGE_JS` 字符串常量；主进程在
 * `arale://` 协议处理器里把它注入每个章节的 HTML。渲染进程负责响应它发出的消息。
 *
 * 为什么要一个字符串常量而不是打包一个 .js 文件：脚本必须在 **iframe 里**执行，
 * 而 iframe 的 origin 是 `arale://`，拿不到 Vite 打包出来的 renderer bundle。把它当
 * 源码常量由主进程内联注入，是唯一不需要第二个构建产物的做法。
 *
 * 消息全部带 `FUSHI_BRIDGE_TAG`，父窗口只接受来自**自己那个 iframe** 且 tag 匹配的
 * 消息（书里的脚本已被 sanitize 剥掉，但纵深防御不靠单点）。
 */

/** 消息信封标记。父窗口与 iframe 脚本共用。 */
export const FUSHI_BRIDGE_TAG = 'arale-bridge-v1';

/** iframe → 父窗口。 */
export type BridgeToHost =
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'ready';
      /** iframe 内全文的 UTF-16 长度（= 桥接脚本自己的偏移基准）。 */
      textLength: number;
    }
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'click';
      /** 点击处前后最多 400 字的上下文，已折叠空白。 */
      context: string;
      /** 点击位置在 `context` 内的 UTF-16 偏移。 */
      offset: number;
      /** 点击位置在全文里的 UTF-16 偏移。 */
      absoluteOffset: number;
      /** 命中字符相对 iframe 视口的矩形，供父窗口定位弹窗。 */
      rect: { x: number; y: number; width: number; height: number };
      /** 选中的词（桥接脚本尽力给出的整词，可能为空串）。 */
      word: string;
    }
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'selection';
      /**
       * 用户**明确框住**的原文。上层必须按它精确查词，不许再做最长匹配去猜——
       * 这是划词与点击的全部区别所在。
       */
      text: string;
      /** 选区所在段落（`textAround` 的结果），给 LLM 当上下文用。 */
      context: string;
      /** 选区起点在 `context` 内的 UTF-16 偏移。 */
      offset: number;
      /** 选区起点在全文里的 UTF-16 偏移（给高亮用）。 */
      absoluteOffset: number;
      /** 选区在 iframe 视口内的矩形，供父窗口定位弹窗。 */
      rect: { x: number; y: number; width: number; height: number };
    }
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'position';
      absoluteOffset: number;
      /** 0..10000 的归一化进度，用于跨版本兜底。 */
      fraction: number;
    }
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'link';
      /** 章节内被点击的内部链接 href（原样，父窗口解析）。 */
      href: string;
    }
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'resize';
      scrollHeight: number;
    };

/** 父窗口 → iframe。 */
export type HostToBridge =
  | { tag: typeof FUSHI_BRIDGE_TAG; type: 'restore'; absoluteOffset: number }
  /**
   * 高亮一段文字。
   *
   * `persistent: true` —— **一直画着**，直到收到 `clearHighlight` 或被下一次
   * `highlight` 顶掉。划词开词卡走这条：卡片还开着，页面上就得一直标着用户划的是哪一段。
   *
   * 缺省（false）—— 2.4 s 后自己消失。点击查词走这条：只是"闪一下告诉你查的是哪个词"，
   * 不值得长期占着版面。
   */
  | {
      tag: typeof FUSHI_BRIDGE_TAG;
      type: 'highlight';
      start: number;
      end: number;
      persistent?: boolean;
    }
  /** 清掉 `persistent` 那份高亮（点击查词的临时下划线不受影响）。 */
  | { tag: typeof FUSHI_BRIDGE_TAG; type: 'clearHighlight' }
  /**
   * 一次性设置全部外观变量。**优先用这条**：`fontScale`/`mode` 是早期拆开的两条消息，
   * 保留是为了不破坏已写好的调用方，新代码一律发 `appearance`——拆成多条会在切换主题
   * 时让 CSS 变量短暂处于「一半新一半旧」的状态，出现一帧闪烁。
   */
  | { tag: typeof FUSHI_BRIDGE_TAG; type: 'appearance'; value: ReaderAppearance }
  | { tag: typeof FUSHI_BRIDGE_TAG; type: 'fontScale'; value: number }
  | { tag: typeof FUSHI_BRIDGE_TAG; type: 'mode'; vertical: boolean };

/** 阅读器可调的外观参数。渲染进程算好 CSS 变量后透传给 iframe。 */
export interface ReaderAppearance {
  fontScale: number;
  vertical: boolean;
  fontFamily: string;
  lineHeight: number;
  margin: number;
}

/**
 * 注入 iframe 的桥接脚本源码。
 *
 * 约束（改了会坏）：
 * - 必须是 **ES5 级别的原生 JS**，不能 import，不能用打包器语法；
 * - 全文偏移 = 文档序下所有文本节点 `nodeValue` 拼接；`buildIndex` 一次、之后缓存；
 * - 点击用 `document.caretRangeFromPoint`（Chromium 有，Safari 没有；我们只跑
 *   Chromium）拿 node+offset，再换算成全局偏移；
 * - 滚动只发 `position`，节流 150ms，避免滚动时 IPC 洪水。
 */
export const READER_BRIDGE_JS = String.raw`
(function () {
  var TAG = '${FUSHI_BRIDGE_TAG}';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, HEAD: 1, RT: 1 };
  var nodes = null;
  var starts = null;
  var total = 0;

  function buildIndex() {
    nodes = [];
    starts = [];
    total = 0;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentNode;
      if (parent && SKIP[parent.nodeName]) continue;
      if (!node.nodeValue) continue;
      nodes.push(node);
      starts.push(total);
      total += node.nodeValue.length;
    }
  }

  function ensureIndex() {
    if (!nodes) buildIndex();
  }

  function offsetOf(node, offsetInNode) {
    ensureIndex();
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return starts[i] + offsetInNode;
    }
    return -1;
  }

  function nodeAt(offset) {
    ensureIndex();
    if (!nodes.length) return null;
    var lo = 0;
    var hi = nodes.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { node: nodes[lo], start: starts[lo] };
  }

  function textAround(offset) {
    ensureIndex();
    var HALF = 200;
    var from = Math.max(0, offset - HALF);
    var to = Math.min(total, offset + HALF);
    var parts = [];
    var cursor = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      var nodeStart = starts[i];
      var nodeEnd = nodeStart + len;
      if (nodeEnd <= from) continue;
      if (nodeStart >= to) break;
      var s = Math.max(0, from - nodeStart);
      var e = Math.min(len, to - nodeStart);
      if (nodeStart + s > cursor) parts.push(' ');
      parts.push(nodes[i].nodeValue.slice(s, e));
      cursor = nodeEnd;
    }
    return parts.join('');
  }

  function post(message) {
    message.tag = TAG;
    try { parent.postMessage(message, '*'); } catch (e) { /* 父窗口没了 */ }
  }

  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      var range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  // 从点击处向前后扩出「词」：CJK 逐字扩到标点/空白，拉丁按词边界。
  var BREAK = /[\s、。，．！？「」『』（）()\[\]{}<>・…—–\-—:;'"\u3000]/;

  function expandWord(node, offsetInNode) {
    var value = node.nodeValue || '';
    var start = offsetInNode;
    var end = offsetInNode;
    while (start > 0 && !BREAK.test(value.charAt(start - 1))) start--;
    while (end < value.length && !BREAK.test(value.charAt(end))) end++;
    return value.slice(start, end);
  }

  // 划词：mouseup 时如果存在非折叠选区就汇报。
  //
  // 为什么用 mouseup 而不是 selectionchange：selectionchange 在拖选过程中会连续触发
  // （一次拖动几十次），每次都查词会把词典和 UI 都打爆。mouseup 是「用户选完了」这个
  // 语义上唯一的时刻。
  //
  // 另外要跟 click 去重：**拖选结束也会派发 click**（浏览器认为整段拖选是一次点击），
  // 所以先记下是不是刚汇报过选区，是就让紧接着的那个 click 不再重复汇报。
  var lastSelectionAt = 0;
  document.addEventListener('mouseup', function () {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    var text = String(selection.toString() || '').trim();
    if (text === '') return;

    var range = selection.getRangeAt(0);
    var node = range.startContainer;
    if (!node) return;
    var absolute = offsetOf(node, range.startOffset);
    var rect = range.getBoundingClientRect();
    var context = textAround(absolute);
    // 选区起点在 context 窗口内的偏移（textAround 以绝对偏移为中心取一段）。
    var windowStart = Math.max(0, absolute - 200);
    var offset = Math.max(0, absolute - windowStart);

    lastSelectionAt = Date.now();
    post({
      type: 'selection',
      text: text,
      context: context,
      offset: offset,
      absoluteOffset: absolute,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    });
  }, true);

  document.addEventListener('click', function (event) {
    // 刚汇报过选区 → 这次 click 是拖选的收尾，忽略。
    if (Date.now() - lastSelectionAt < 300) return;
    var target = event.target;
    if (target && target.nodeName === 'A') {
      var href = target.getAttribute('href') || '';
      if (href && href.charAt(0) !== '#' && href.indexOf('http') !== 0) {
        event.preventDefault();
        post({ type: 'link', href: href });
        return;
      }
    }
    var range = caretFromPoint(event.clientX, event.clientY);
    if (!range) return;
    var node = range.startContainer;
    if (!node || node.nodeType !== 3) return;
    var absolute = offsetOf(node, range.startOffset);
    if (absolute < 0) return;
    var context = textAround(absolute);
    // textAround 拼出来的串里，点击点的位置需要重新定位：用节点前文重算。
    var prefix = '';
    ensureIndex();
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) {
        var from = Math.max(0, absolute - 200);
        // 简化：偏移 = 点击点 - 窗口起点，窗口起点 = max(0, absolute-200)
        prefix = node.nodeValue.slice(0, range.startOffset);
        break;
      }
    }
    var offset = Math.max(0, absolute - Math.max(0, absolute - 200));
    var rect = range.getBoundingClientRect();
    post({
      type: 'click',
      context: context,
      offset: offset,
      absoluteOffset: absolute,
      word: expandWord(node, range.startOffset),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    });
  }, true);

  var lastSent = 0;
  function reportPosition() {
    var now = Date.now();
    if (now - lastSent < 150) return;
    lastSent = now;
    ensureIndex();
    var range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(Math.round(window.innerWidth / 2), 4)
      : null;
    var absolute = 0;
    if (range && range.startContainer && range.startContainer.nodeType === 3) {
      var value = offsetOf(range.startContainer, range.startOffset);
      if (value >= 0) absolute = value;
    }
    var scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    var fraction = Math.round(Math.max(0, Math.min(1, window.scrollY / scrollable)) * 10000);
    post({ type: 'position', absoluteOffset: absolute, fraction: fraction });
  }

  window.addEventListener('scroll', reportPosition, { passive: true });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.tag !== TAG) return;
    if (data.type === 'restore') {
      var hit = nodeAt(data.absoluteOffset);
      if (hit) {
        var offsetInNode = data.absoluteOffset - hit.start;
        var probe = document.createRange();
        try {
          probe.setStart(hit.node, Math.max(0, Math.min(hit.node.nodeValue.length, offsetInNode)));
          probe.collapse(true);
          var box = probe.getBoundingClientRect();
          if (box && (box.top || box.left)) {
            window.scrollTo(window.scrollX, window.scrollY + box.top - 12);
          }
        } catch (e) { /* 节点已变，忽略 */ }
      }
    } else if (data.type === 'highlight') {
      highlight(data.start, data.end, !!data.persistent);
    } else if (data.type === 'clearHighlight') {
      clearHighlight();
    } else if (data.type === 'appearance') {
      applyAppearance(data.value || {});
    } else if (data.type === 'fontScale') {
      document.documentElement.style.setProperty('--arale-font-scale', String(data.value));
    } else if (data.type === 'mode') {
      document.documentElement.classList.toggle('arale-vertical', !!data.vertical);
    }
  });

  function applyAppearance(value) {
    var root = document.documentElement;
    if (typeof value.fontScale === 'number') {
      root.style.setProperty('--arale-font-scale', String(value.fontScale));
    }
    if (typeof value.fontFamily === 'string') {
      root.style.setProperty('--arale-font-family', value.fontFamily);
    }
    if (typeof value.lineHeight === 'number') {
      root.style.setProperty('--arale-line-height', String(value.lineHeight));
    }
    if (typeof value.margin === 'number') {
      root.style.setProperty('--arale-margin', value.margin + 'px');
    }
    root.classList.toggle('arale-vertical', !!value.vertical);
  }

  // 高亮元素分成两类，互不干扰：
  //   persistentEls —— 划词那份，卡片关掉才清（clearHighlight）；
  //   transientEls  —— 点击查词那份，2.4 s 自己消失。
  // 分开存是必要的：卡片关闭时发的 clearHighlight 不能顺手把点击那条下划线也抹掉
  // （点词查卡是另一条路径，两者会前后脚发生）。
  // 注意：这一段在**模板字符串**里，注释里不能出现反引号（会把字符串截断）。
  var persistentEls = [];
  var transientEls = [];
  var transientTimer = null;

  function removeEls(els) {
    for (var i = 0; i < els.length; i++) {
      if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
    els.length = 0;
  }

  // 画一段高亮，一段一行（range.getClientRects()）。
  // 早前是整段画一个大框：跨行选区会把行间空白也盖住，看着像"选错了范围"。
  // 返回是否真的画上了（拿不到节点或选区为空时为 false）。
  function paint(start, end, els) {
    var a = nodeAt(start);
    var b = nodeAt(end);
    if (!a || !b) return false;
    try {
      var range = document.createRange();
      range.setStart(a.node, Math.max(0, start - a.start));
      range.setEnd(b.node, Math.max(0, end - b.start));
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width < 0.5 && r.height < 0.5) continue;
        var el = document.createElement('div');
        el.className = 'arale-highlight';
        el.style.left = r.left + window.scrollX + 'px';
        el.style.top = r.top + window.scrollY + 'px';
        el.style.width = Math.max(2, r.width) + 'px';
        el.style.height = Math.max(2, r.height) + 'px';
        document.body.appendChild(el);
        els.push(el);
      }
    } catch (e) { /* 越界忽略 */ }
    return els.length > 0;
  }

  function highlight(start, end, persistent) {
    if (persistent) {
      removeEls(persistentEls);
      // 划词高亮一出现，点击留下的临时框就让位（同一段文字上叠两个框更乱）。
      removeEls(transientEls);
      if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
      paint(start, end, persistentEls);
      return;
    }
    removeEls(transientEls);
    if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
    if (!paint(start, end, transientEls)) return;
    transientTimer = setTimeout(function () {
      removeEls(transientEls);
      transientTimer = null;
    }, 2400);
  }

  // 只清持久那份：点击查词的临时下划线归它自己的定时器管。
  function clearHighlight() {
    removeEls(persistentEls);
  }

  function boot() {
    buildIndex();
    window.addEventListener('resize', function () {
      post({ type: 'resize', scrollHeight: document.documentElement.scrollHeight });
    });
    post({ type: 'ready', textLength: total });
    post({ type: 'resize', scrollHeight: document.documentElement.scrollHeight });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;
