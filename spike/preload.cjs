const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localLedger', {
  command: (payload) => ipcRenderer.invoke('ledger:command', payload),
});
