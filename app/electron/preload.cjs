const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pp', {
  ai: {
    reply: (payload) => ipcRenderer.invoke('ai-reply', payload),
    golden: (payload) => ipcRenderer.invoke('ai-golden', payload),
  },
  win: {
    setIgnoreMouse: (v) => ipcRenderer.send('set-ignore-mouse', v),
    moveBy: (dx, dy) => ipcRenderer.send('move-by', dx, dy),
  },
  on: (channel, cb) => {
    if (channel === 'sedentary') ipcRenderer.on(channel, () => cb());
  },
});
