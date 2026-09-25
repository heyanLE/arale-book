/**
 * 应用菜单。
 *
 * 桌面端和网页的差别，一半在菜单栏：快捷键、系统级「打开方式」、macOS 的
 * 应用菜单约定。Calibre 风格的应用必须有一个像样的菜单，而不是把所有操作塞进界面按钮。
 *
 * 菜单项**不直接改状态**，而是发 `shell:command` 事件给渲染进程——渲染进程才是
 * 视图状态的唯一持有者，菜单只表达意图。这样「菜单能做什么」和「快捷键能做什么」
 * 天然一致（快捷键也走同一条命令）。
 */

import { Menu, dialog, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

import type { ShellCommand } from '../shared/ipc';
import { APP_NAME_EN, APP_NAME_FULL, APP_NAME_JA, APP_TAGLINE } from '../shared/brand';
import { emitEvent } from './events';

export interface MenuContext {
  getWindow: () => BrowserWindow | null;
}

function command(context: MenuContext, command: ShellCommand): void {
  void context;
  emitEvent('shell:command', { command });
}

export function installMenu(context: MenuContext): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: APP_NAME_JA,
            submenu: [
              { label: `关于 ${APP_NAME_FULL}`, role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '导入漫画 / 小说…',
          accelerator: 'CmdOrCtrl+O',
          click: () => command(context, 'import'),
        },
        {
          label: '打开词典设置…',
          accelerator: 'CmdOrCtrl+D',
          click: () => command(context, 'settings'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: '在全库中搜索',
          accelerator: 'CmdOrCtrl+F',
          click: () => command(context, 'toggleSidebar'),
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '显示 / 隐藏侧栏',
          accelerator: 'CmdOrCtrl+B',
          click: () => command(context, 'toggleSidebar'),
        },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => command(context, 'zoomIn') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => command(context, 'zoomOut') },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => command(context, 'zoomReset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '阅读',
      submenu: [
        { label: '上一页', accelerator: 'Left', click: () => command(context, 'prevPage') },
        { label: '下一页', accelerator: 'Right', click: () => command(context, 'nextPage') },
        { type: 'separator' },
        {
          label: '查词面板',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => command(context, 'toggleDictionary'),
        },
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        {
          label: `${APP_NAME_JA} 是什么`,
          click: () => {
            // 用原生对话框而不是往渲染进程派事件：这条菜单项只讲一件事（这是什么应用），
            // 为它加一条渲染进程的消息通道不划算，而且原生对话框在菜单上下文里更自然。
            void dialog.showMessageBox({
              type: 'info',
              title: APP_NAME_FULL,
              message: `${APP_NAME_JA}  (${APP_NAME_EN})`,
              detail: [
                APP_TAGLINE,
                '',
                '本地优先：书库、阅读、分词、查词全部离线，不上传任何内容。',
                '漫画与小说共用一套书库；漫画的文字层来自 .mokuro / manga.json，',
                '也可以用内置 OCR 或外部 OCR 引擎现场生成。',
              ].join('\n'),
              buttons: ['好'],
              defaultId: 0,
            });
          },
        },
        {
          label: '关于 Electron',
          click: () => void shell.openExternal('https://www.electronjs.org'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
