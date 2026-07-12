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
  store: {
    // sendSync: one blocking read at boot, before anything renders
    load: () => ipcRenderer.sendSync('state-load') as string | null,
    save: (json: string) => ipcRenderer.send('state-save', json),
    reset: () => ipcRenderer.send('state-reset'),
    // chat transcript (chat.jsonl) — sendSync reads are a few ms of file IO,
    // done once at boot and per Book scroll-up page
    chatLoad: (before: number | null, limit: number) =>
      ipcRenderer.sendSync('chat-load', { before, limit }) as { lines: string[]; total: number },
    chatAppend: (lines: string[]) => ipcRenderer.send('chat-append', lines),
    chatRewrite: (lines: string[]) => ipcRenderer.send('chat-rewrite', lines),
  },
  lang: {
    report: (pref: string, effective: string) => ipcRenderer.send('lang-changed', { pref, effective }),
  },
  win: {
    setIgnoreMouse: (v: boolean) => ipcRenderer.send('set-ignore-mouse', v),
    moveBy: (dx: number, dy: number) => ipcRenderer.invoke('move-by', dx, dy),
    panelSide: () => ipcRenderer.invoke('panel-side'),
    setModal: (v: boolean) => ipcRenderer.send('set-modal', v),
    modalGeometry: () => ipcRenderer.invoke('modal-geometry'),
  },
  on: (channel: string, cb: (data: unknown) => void) => {
    if (
      channel === 'sedentary' ||
      channel === 'cursor' ||
      channel === 'edge' ||
      channel === 'set-lang' ||
      channel === 'update-note'
    ) {
      ipcRenderer.on(channel, (_e, data) => cb(data));
    }
  },
});
