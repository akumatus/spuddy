// Preload bridge — the only surface the sandboxed renderer sees. The shape is
// typed as PreloadBridge in src/types.ts; keep the two in sync.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pp', {
  debug: process.env.PP_DEBUG === '1',
  ai: {
    reply: (payload: unknown) => ipcRenderer.invoke('ai-reply', payload),
    golden: (payload: unknown) => ipcRenderer.invoke('ai-golden', payload),
    greet: (payload: unknown) => ipcRenderer.invoke('ai-greet', payload),
  },
  cards: {
    today: (lang?: string) => ipcRenderer.invoke('cards-today', lang),
  },
  lang: {
    report: (pref: string, effective: string) => ipcRenderer.send('lang-changed', { pref, effective }),
  },
  win: {
    setIgnoreMouse: (v: boolean) => ipcRenderer.send('set-ignore-mouse', v),
    moveBy: (dx: number, dy: number) => ipcRenderer.invoke('move-by', dx, dy),
    setModal: (v: boolean) => ipcRenderer.send('set-modal', v),
    modalGeometry: () => ipcRenderer.invoke('modal-geometry'),
  },
  on: (channel: string, cb: (data: unknown) => void) => {
    if (channel === 'sedentary' || channel === 'cursor' || channel === 'edge' || channel === 'set-lang') {
      ipcRenderer.on(channel, (_e, data) => cb(data));
    }
  },
});
