// Preload bridge — the only surface the sandboxed renderer sees. The shape is
// typed as PreloadBridge in src/types.ts; keep the two in sync.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pp', {
  debug: process.env.PP_DEBUG === '1',
  ai: {
    reply: (payload: unknown) => ipcRenderer.invoke('ai-reply', payload),
    distill: (payload: unknown) => ipcRenderer.invoke('ai-distill', payload),
    consolidate: (payload: unknown) => ipcRenderer.invoke('ai-consolidate', payload),
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
  // seconds since the human last touched keyboard/mouse (system-wide)
  idleSeconds: () => ipcRenderer.invoke('system-idle-seconds'),
  win: {
    setIgnoreMouse: (v: boolean) => ipcRenderer.send('set-ignore-mouse', v),
    moveBy: (dx: number, dy: number, lift?: number) => ipcRenderer.invoke('move-by', dx, dy, lift),
    dock: (side: string) => ipcRenderer.invoke('dock-snap', side),
    panelSide: () => ipcRenderer.invoke('panel-side'),
  },
  // pet-renderer side of the popup bridge: mirror markup out, take clicks
  // (and scroll page-up reports) back
  popup: {
    show: (html: string, panel: boolean, htmlClass: string) => ipcRenderer.send('popup-show', html, panel, htmlClass),
    hide: () => ipcRenderer.send('popup-hide'),
    onClick: (cb: (path: number[]) => void) => ipcRenderer.on('popup-click', (_e, path) => cb(path)),
    onPageUp: (cb: (path: number[]) => void) => ipcRenderer.on('popup-pageup', (_e, path) => cb(path)),
  },
  // popup-window side: receive markup, report clicks, page-up hits and the
  // content size
  popupShell: {
    onRender: (cb: (html: string, panel: boolean, htmlClass: string) => void) =>
      ipcRenderer.on('popup-render', (_e, html, panel, htmlClass) => cb(html, panel, htmlClass)),
    onHidden: (cb: () => void) => ipcRenderer.on('popup-hidden', () => cb()),
    click: (path: number[]) => ipcRenderer.send('popup-click', path),
    pageUp: (path: number[]) => ipcRenderer.send('popup-pageup', path),
    resize: (w: number, h: number) => ipcRenderer.send('popup-resize', w, h),
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
