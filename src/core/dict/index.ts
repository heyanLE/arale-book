/**
 * 词典子系统 barrel —— 主进程 / 测试都从 `core/dict` 单一入口 import。
 *
 * 分层（依赖只能向下）：
 *   normalize（无依赖）
 *   scanner（无依赖）
 *   deinflect（依赖 shared/types + data/ja-transforms.json）
 *   yomitan（依赖 normalize + util/*）      —— 导入、落盘、索引、释义渲染
 *   lookup（依赖 scanner + deinflect + normalize + yomitan）
 *   store（依赖上面全部）                    —— 主进程唯一入口
 */

export * from './normalize';
export * from './kanji-variants';
export * from './scanner';
export * from './deinflect';
export * from './yomitan';
export * from './lookup';
export * from './store';
