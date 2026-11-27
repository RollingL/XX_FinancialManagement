const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('localOcr', {
  recognize: (id, bytes) => ipcRenderer.invoke('ocr:recognize', { id, bytes }),
  cancel: (id) => ipcRenderer.send('ocr:cancel', id),
});

contextBridge.exposeInMainWorld('localLedger', {
  command: (payload) => ipcRenderer.invoke('ledger:command', payload),
});
