/**
 * 品牌常量（唯一定义处）。
 *
 * 产品的**主名称是日文 `あられブック`**，英文写作 `ARaLeBook`。两者都要能出现：
 * 窗口标题、应用菜单、关于页用日文主名称；文件系统/包名/协议标识用 ASCII，
 * 因为跨平台路径与 URL scheme 里塞非 ASCII 会引入一堆无谓的转义问题。
 *
 * 命名由来：`あられ`（霰，米粒状的雪/冰粒）→ 书名里的「粒」——一本书被拆成一个个
 * 词粒。英文按日文读音取 `ARaLe`，后缀 `Book`。大小写刻意是 `ARaLe`：A-R-L 大写、
 * a-e 小写，读起来是「あられ」的音节切分。
 */

/** 主名称（日文）。窗口标题、应用菜单、关于页用它。 */
export const APP_NAME_JA = 'あられブック';

/** 英文名。副标题、包名、文档标题用它。 */
export const APP_NAME_EN = 'ARaLeBook';

/** 两者并列时的完整写法。 */
export const APP_NAME_FULL = `${APP_NAME_JA} (${APP_NAME_EN})`;

/**
 * ASCII 标识符：npm 包名、`arale://` 协议、数据目录名。
 * **不要**把它换成日文——它会进 `app.getPath('userData')` 与 URL。
 */
export const APP_ID = 'aralebook';

/** 窗口标题。 */
export const APP_WINDOW_TITLE = APP_NAME_FULL;

/** 一句话介绍（关于页 / 空状态用）。 */
export const APP_TAGLINE = '漫画与小说的本地书库 · 分词 · 点词查义';
