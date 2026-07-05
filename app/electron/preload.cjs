const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pp', {
  debug: process.env.PP_DEBUG === '1',
  ai: {
    reply: (payload) => ipcRenderer.invoke('ai-reply', payload),
    golden: (payload) => ipcRenderer.invoke('ai-golden', payload),
  },
  win: {
    setIgnoreMouse: (v) => ipcRenderer.send('set-ignore-mouse', v),
    moveBy: (dx, dy) => ipcRenderer.send('move-by', dx, dy),
    setModal: (v) => ipcRenderer.send('set-modal', v),
    modalGeometry: () => ipcRenderer.invoke('modal-geometry'),
  },
  on: (channel, cb) => {
    if (channel === 'sedentary' || channel === 'cursor' || channel === 'edge') {
      ipcRenderer.on(channel, (_e, data) => cb(data));
    }
  },
});
