// What the window shows around the page: its menu and the language of built-in controls.

// Date boxes, the file picker button and other built-in controls follow this language,
// whatever language the computer itself uses.
const INTERFACE_LANGUAGE = 'zh-CN';

// Windows and Linux get no menu bar. Electron's default one is in English and offers
// Reload and Developer Tools, which a user never needs and could hit by accident.
// macOS keeps a small Chinese menu, because copy, paste and quit shortcuts need it there.
function menuTemplate(platform) {
  if (platform !== 'darwin') return null;
  return [
    {
      label: '钱来',
      submenu: [
        { role: 'hide', label: '隐藏钱来' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出钱来' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ];
}

module.exports = { INTERFACE_LANGUAGE, menuTemplate };
