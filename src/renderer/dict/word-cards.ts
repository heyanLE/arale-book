/**
 * 词卡弹窗 + 词卡夹的**状态中枢**。
 *
 * 抽成 hook 而不是在 `ComicReader` 与 `EpubReader` 里各写一份：两个阅读器的**交互
 * 完全一样**（点击查词、划词、pin、保存、LLM 分析），只有「怎么拿到锚点矩形」不同。
 * 各写一份必然出现「那边修了这边没修」。
 *
 * ## 一次只能有一张「临时卡」
 *
 * 点击查词的心智模型是「我点了另一个词 → 换成那个词」。所以打开新卡时会先关掉**所有
 * 未固定的**卡；固定过的卡留着——那正是 pin 的意义。于是「多张卡」= 用户主动 pin 出来的，
 * 不需要额外的开关。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LlmProfile,
  LookupResult,
  WordCard,
  WordCardAnalysis,
  WordCardDraft,
} from '@shared/types';
import { collectContainedAnalyses, sortAnalyses, type AnalysedSource } from '@core/cards/analyses';
import { api, call, run } from '../lib/api';
import type { AnchorRect } from './WordCardPopup';

export interface WordCardLookupInput {
  /** 顶部词的初值。点击时是扫描命中的表面形；划词时是选区原文。 */
  word: string;
  context: string;
  offset: number;
  /** 划词的选区长度；点击查词传 0。 */
  length: number;
  anchor: AnchorRect;
  /** 词典结果。点击时已查好；划词时由调用方先查。 */
  result: LookupResult | null;
}

export interface WordCardPopupState extends WordCardLookupInput {
  id: string;
  pinned: boolean;
  /** 选中的词典 id；null = 跟随最佳命中。 */
  dictionaryId: string | null;
  /** 这张卡上所有 LLM 分析（短词在前），最后一条通常是当前词自己的。 */
  analyses: WordCardAnalysis[];
  /** 正在分析哪个词；null = 没在跑。 */
  analyzingWord: string | null;
  /** 这张卡临时指定的 LLM 配置；null = 用设置里的默认。 */
  llmProfileId: string | null;
  /** 上一次失败的原文（显示在一次操作上，不写进词卡）。 */
  lastError: string | null;
  /** 上一次成功用的配置名（显示用）。 */
  llmProfileName: string | null;
  saving: boolean;
}

export interface UseWordCardsResult {
  popups: WordCardPopupState[];
  cards: WordCard[];
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  openPopup: (input: WordCardLookupInput) => string;
  closePopup: (id: string) => void;
  togglePin: (id: string) => void;
  setWord: (id: string, word: string) => void;
  selectDictionary: (id: string, dictionaryId: string) => void;
  savePopup: (id: string) => void;
  /** 分析指定词（子句词或当前词）。 */
  analyzeWord: (id: string, word: string) => void;
  /** 删掉某条分析（按词定位）。 */
  removeAnalysis: (id: string, word: string) => void;
  /** 这张卡临时指定用哪套 LLM 配置。 */
  selectLlmProfile: (id: string, profileId: string | null) => void;
  /** 从词卡夹里打开某张卡（会重新查一次词典，因为释义不该缓存进词卡）。 */
  openCard: (card: WordCard) => Promise<void>;
  removeCard: (id: string) => void;
  /** 这张卡的词是否已经在词卡夹里（决定保存按钮的文案）。 */
  isSaved: (popup: WordCardPopupState) => boolean;
  /**
   * 设置里配置的 LLM 列表。hook 自己去拉，不走 props 透传 ——
   * 它只在词卡上用，为它把 App → ReaderView → 两个阅读器一路加参数不值得。
   */
  llmProfiles: LlmProfile[];
}

let popupSeq = 0;

/**
 * LLM 分析结果的**会话内缓存**。
 *
 * 为什么需要：一张弹窗关掉再打开（或同一本书里翻回同一个词）时重跑一次模型既慢又费钱，
 * 而同一个词在同一个上下文里的答案不会变。键包含上下文，因为同一个词在不同句子里
 * 含义可能不同——只按词缓存会给出错误答案。
 *
 * 为什么不落盘：分析结果属于「词卡」而不是「弹窗」，落盘由词卡负责（保存时把
 * `analysis` 一起写进 cards.json）。这里的缓存只解决「没保存的临时卡反复问」。
 */
const analysisCache = new Map<string, WordCardAnalysis>();

function analysisKey(word: string, context: string): string {
  return `${word}\u0000${context}`;
}

/**
 * 会话缓存 → 收集函数的输入。
 *
 * 键里带着上下文，所以要把上下文**解出来**：同一个词在两句话里各分析过一次时，
 * 收集函数要能优先挑「这句话里那次」。`\u0000` 是键的分隔符，不会出现在正常文本里。
 */
function sessionSources(): AnalysedSource[] {
  const out: AnalysedSource[] = [];
  for (const [key, analysis] of analysisCache) {
    const at = key.indexOf('\u0000');
    out.push({ analysis, context: at >= 0 ? key.slice(at + 1) : '' });
  }
  return out;
}

/**
 * 把某个词的**全部**会话缓存删掉（同一个词在不同段落可能各有一条）。
 *
 * 删除必须按词清干净：只删当前上下文那一条的话，换个段落再划到同一个词，旧分析又"回来"了。
 */
function clearCachedAnalyses(word: string): void {
  for (const key of [...analysisCache.keys()]) {
    const at = key.indexOf('\u0000');
    if ((at >= 0 ? key.slice(0, at) : key) === word) analysisCache.delete(key);
  }
}

/** 收集当前词 + 它包含的已分析词：词卡（持久化）与会话缓存合并去重。 */
function collectAnalyses(
  word: string,
  context: string,
  cards: readonly WordCard[],
  ownAnalyses?: readonly WordCardAnalysis[],
): WordCardAnalysis[] {
  return collectContainedAnalyses({
    word,
    context,
    cards,
    session: sessionSources(),
    ...(ownAnalyses !== undefined ? { ownAnalyses } : {}),
  });
}

/** 从词卡夹打开时的锚点：面板在右侧，所以卡片落在面板左边一点。 */
function panelAnchor(): AnchorRect {
  return { x: Math.max(16, window.innerWidth - 520), y: 72, width: 0, height: 0 };
}

export function useWordCards(bookId: string): UseWordCardsResult {
  const [popups, setPopups] = useState<WordCardPopupState[]>([]);
  const [cards, setCards] = useState<WordCard[]>([]);
  const [panelOpen, setPanelOpenState] = useState(false);
  const [llmProfiles, setLlmProfiles] = useState<LlmProfile[]>([]);
  /**
   * 最新词卡列表的 ref。
   *
   * `openPopup` 必须保持**稳定引用**（它被划词回调、阅读器的查词路径直接调用，身份一变
   * 就会连锁重建一堆 useCallback），但又不能读到过期的词卡——子句分析正是从词卡里来的。
   * 所以用 ref 读最新值，而不是把 `cards` 塞进依赖。
   */
  const cardsRef = useRef<WordCard[]>([]);
  cardsRef.current = cards;

  useEffect(() => {
    void api.llm
      .settings()
      .then((settings) => setLlmProfiles(settings.profiles))
      .catch(() => undefined);
  }, []);

  // 换书就把弹窗全部清掉：上一本的词卡飘在新书上既是 bug 也是误导。
  const bookRef = useRef(bookId);
  useEffect(() => {
    if (bookRef.current === bookId) return;
    bookRef.current = bookId;
    setPopups([]);
    setPanelOpen(false);
  }, [bookId]);

  const reload = useCallback(async () => {
    const list = await call('读取词卡', () => api.cards.list(bookId));
    setCards(list ?? []);
  }, [bookId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 开词卡夹时**重新读一次盘**。
   *
   * 列表是「这本书存过什么」的快照。不重读的话，在别处（另一本书的窗口、将来的同步、
   * 手改文件）产生的变化不会体现出来；而打开面板正是用户想看最新状态的时刻。
   */
  const setPanelOpen = useCallback(
    (open: boolean) => {
      setPanelOpenState(open);
      if (open) void reload();
    },
    [reload],
  );

  const openPopup = useCallback((input: WordCardLookupInput): string => {
    popupSeq += 1;
    const id = `p${popupSeq}`;
    setPopups((prev) => [
      // 未固定的卡让位（点另一个词就是换一张卡）；固定的留着。
      ...prev.filter((item) => item.pinned),
      {
        ...input,
        id,
        pinned: false,
        dictionaryId: null,
        // 当前词**包含**的已分析词（先划 A、再划 AB ⇒ A 的分析也在这儿）+ 会话缓存里的。
        analyses: collectAnalyses(input.word, input.context, cardsRef.current),
        analyzingWord: null,
        llmProfileId: null,
        lastError: null,
        llmProfileName: null,
        saving: false,
      },
    ]);
    return id;
  }, []);

  const closePopup = useCallback((id: string) => {
    setPopups((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const togglePin = useCallback((id: string) => {
    setPopups((prev) =>
      prev.map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item)),
    );
  }, []);

  const patchPopup = useCallback((id: string, patch: Partial<WordCardPopupState>) => {
    setPopups((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const setWord = useCallback(
    (id: string, word: string) => patchPopup(id, { word }),
    [patchPopup],
  );

  const selectDictionary = useCallback(
    (id: string, dictionaryId: string) => patchPopup(id, { dictionaryId }),
    [patchPopup],
  );

  /** 词卡里记的辞书形：取当前选中词典（或最佳命中）的那一条。 */
  const dictionaryOf = useCallback((popup: WordCardPopupState) => {
    const results = popup.result?.results ?? [];
    const active = popup.dictionaryId;
    return (
      results.find((entry) => active === null || entry.term.dictionaryId === active) ??
      results[0] ??
      null
    );
  }, []);

  /**
   * 当前弹窗对应的**已保存词卡**（没保存过就是 undefined）。
   *
   * 去重口径与主进程、`isSaved` 完全一致（词 + 辞书形）：两处不一致就会出现「界面说已保存、
   * 分析却写不回那张卡」。
   */
  const savedCardFor = useCallback(
    (popup: WordCardPopupState): WordCard | undefined => {
      const expression = dictionaryOf(popup)?.term.expression ?? '';
      return cardsRef.current.find(
        (card) => card.word === popup.word && card.dictionaryExpression === expression,
      );
    },
    [dictionaryOf],
  );

  const savePopup = useCallback(
    (id: string) => {
      const popup = popups.find((item) => item.id === id);
      if (popup === undefined) return;
      const hit = dictionaryOf(popup);
      const draft: WordCardDraft = {
        word: popup.word,
        context: popup.context,
        offset: popup.offset,
        length: popup.length,
        dictionaryExpression: hit?.term.expression ?? '',
        dictionaryId: hit?.term.dictionaryId ?? '',
        dictionaryTitle: hit?.term.dictionaryTitle ?? '',
        dictionaryReading: hit?.term.reading ?? '',
      };
      patchPopup(id, { saving: true });
      void (async () => {
        const saved = await call('保存词卡', () => api.cards.add(bookId, draft));
        // 保存时把已跑过的 LLM 分析一并写进词卡：重开这本书还能看到，不必再花钱跑一次。
        // 放在 add 之后单独 update，是因为 add 的入参是 WordCardDraft（不含分析结果），
        // 而分析是**后发生**的——用户很可能先保存、再点分析。
        // 子句分析跟着一起保存（用户说的「保存的词卡跟着一起保存」）。
        if (saved !== null && popup.analyses.length > 0) {
          await call('写入分析结果', () =>
            api.cards.update(bookId, saved.id, { analyses: popup.analyses }),
          );
        }
        patchPopup(id, { saving: false });
        if (saved !== null) await reload();
      })();
    },
    [bookId, dictionaryOf, patchPopup, popups, reload],
  );

  const analyzeWord = useCallback(
    (id: string, target: string) => {
      const popup = popups.find((item) => item.id === id);
      if (popup === undefined) return;
      // 「重新分析」就得真的重跑：不清缓存的话，关掉再打开会又回到那份旧的。
      analysisCache.delete(analysisKey(target, popup.context));
      patchPopup(id, { analyzingWord: target });
      void (async () => {
        const result = await call('LLM 分析', () =>
          api.llm.analyze({
            word: target,
            context: popup.context,
            // 词卡上临时指定的配置优先；没指定就让主进程用设置里的默认。
            ...(popup.llmProfileId !== null ? { profileId: popup.llmProfileId } : {}),
          }),
        );
        patchPopup(id, { analyzingWord: null });
        // 失败**不写缓存也不写词卡**：一条「上次分析失败」的记录下次打开显示一段错误，
        // 既没用又像坏了。界面上把原因显示在这次操作上就够了。
        if (result === null || !result.ok) return;
        const stored: WordCardAnalysis = {
          word: target,
          text: result.text,
          profileName: result.profileName,
          model: result.model,
          createdAt: Date.now(),
        };
        analysisCache.set(analysisKey(target, popup.context), stored);
        // ★ 如果这个词已经有词卡，分析**当场落盘**。
        //
        // 不这么做的话「A 的分析」只活在这个弹窗和会话缓存里：关掉、重开、甚至只是划到
        // 更长的 AB，都看不到它（用户报的就是这个）。落盘之后 A 的词卡里就有这条，
        // AB 的词卡按「词包含」把它带出来。
        const owner = savedCardFor(popup);
        if (owner !== undefined) {
          const analyses = sortAnalyses(
            [...owner.analyses.filter((entry) => entry.word !== target), stored],
            owner.word,
          );
          void call('写入分析结果', () => api.cards.update(bookId, owner.id, { analyses })).then(
            (updated) => {
              if (updated !== null) void reload();
            },
          );
        }
        setPopups((prev) =>
          prev.map((item) => {
            if (item.id !== id) return item;
            const others = item.analyses.filter((entry) => entry.word !== target);
            return {
              ...item,
              analyses: sortAnalyses([...others, stored], item.word),
              // 记住这次用的配置与失败原文：界面上要显示「上一次为什么失败」。
              lastError: result.ok ? null : (result.error ?? '分析失败'),
              llmProfileName: result.profileName,
            };
          }),
        );
      })();
    },
    [bookId, patchPopup, popups, reload, savedCardFor],
  );

  /** 删掉一条分析：**缓存也要删**，否则关掉再打开它又回来了。 */
  const removeAnalysis = useCallback(
    (id: string, target: string) => {
      const popup = popups.find((item) => item.id === id);
      if (popup === undefined) return;
      clearCachedAnalyses(target);
      // ★ 删的是「**这个词**的分析」，不只是当前这张卡上的那份。
      //
      // 这一栏可能是**子句包含**带出来的（A 的分析出现在 AB 的卡上），真正存着它的是
      // A 那张卡。只删当前卡的话，关掉重开又会被带出来——用户看到的是「× 按了没用」。
      const owners = cardsRef.current.filter((card) =>
        card.analyses.some((entry) => entry.word === target),
      );
      for (const card of owners) {
        const analyses = card.analyses.filter((entry) => entry.word !== target);
        void call('删掉分析', () => api.cards.update(bookId, card.id, { analyses })).then(
          (updated) => {
            if (updated !== null) void reload();
          },
        );
      }
      setPopups((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, analyses: item.analyses.filter((entry) => entry.word !== target) }
            : item,
        ),
      );
    },
    [bookId, popups, reload],
  );

  const selectLlmProfile = useCallback(
    (id: string, profileId: string | null) => patchPopup(id, { llmProfileId: profileId }),
    [patchPopup],
  );

  const openCard = useCallback(
    async (card: WordCard) => {
      // 词卡只存「用户查的是什么」，不存释义——释义要现查，这样换词典/更新词典之后
      // 打开旧卡看到的仍是最新释义。
      const result = await call('查词', () => api.dict.lookup(card.context, card.offset));
      // 词卡里存过的分析全部灌进缓存：这样在这本书里再划到同一个词就是瞬时出结果。
      for (const entry of card.analyses) {
        analysisCache.set(analysisKey(entry.word, card.context), entry);
      }
      const id = openPopup({
        word: card.word,
        context: card.context,
        offset: card.offset,
        length: card.length,
        anchor: panelAnchor(),
        result: result ?? null,
      });
      patchPopup(id, {
        // 打开时回到保存那一刻选中的词典，而不是每次都跳回最佳命中。
        ...(card.dictionaryId !== '' && result !== null ? { dictionaryId: card.dictionaryId } : {}),
        // 从词卡夹打开也一样：这张卡自己 + 它**包含**的已分析词（A ⊆ AB）。
        analyses: collectAnalyses(card.word, card.context, cardsRef.current, card.analyses),
      });
    },
    [openPopup, patchPopup],
  );

  const removeCard = useCallback(
    (id: string) => {
      run('删除词卡', async () => {
        await api.cards.remove(bookId, id);
        await reload();
      });
    },
    [bookId, reload],
  );

  const savedKeys = useMemo(
    () => new Set(cards.map((card) => `${card.word}\u0000${card.dictionaryExpression}`)),
    [cards],
  );

  const isSaved = useCallback(
    (popup: WordCardPopupState) => {
      const hit = dictionaryOf(popup);
      // 与主进程的**去重口径**保持一致（词 + 辞书形）：两处不一致的话，界面上会出现
      // 「已保存」但再点一次又新增一张的怪现象。
      return savedKeys.has(`${popup.word}\u0000${hit?.term.expression ?? ''}`);
    },
    [dictionaryOf, savedKeys],
  );

  return {
    popups,
    cards,
    panelOpen,
    setPanelOpen,
    openPopup,
    closePopup,
    togglePin,
    setWord,
    selectDictionary,
    savePopup,
    analyzeWord,
    removeAnalysis,
    selectLlmProfile,
    openCard,
    removeCard,
    isSaved,
    llmProfiles,
  };
}
