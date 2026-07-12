// Popup plumbing. Popups render into this window's hidden #modal staging tree
// — every existing popup module keeps building markup and binding handlers
// there exactly as before — and a MutationObserver mirrors the markup into a
// separate popup WINDOW (electron/src/popup.ts). That window sits at normal
// level: other apps stack over it and a click brings it back, while the pet
// window floats above everything, always. Clicks made in the popup window
// come back as child-index paths and are re-dispatched on the staging tree,
// so the handlers (and the state they close over) never know the difference.

export const modal = () => document.getElementById('modal')!;

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

let popupUp = false;
let panelMode = true;
let wired = false;
let mirrorQueued = false;

function mirror(): void {
  mirrorQueued = false;
  if (!popupUp) return;
  window.pp?.popup?.show(modal().innerHTML, panelMode, document.documentElement.className);
}

// batch mutation storms (a book re-render is many childList changes) into one
// mirror per microtask turn
function queueMirror(): void {
  if (mirrorQueued) return;
  mirrorQueued = true;
  queueMicrotask(mirror);
}

function wireOnce(): void {
  if (wired) return;
  wired = true;
  new MutationObserver(queueMirror).observe(modal(), {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  // a popup click, replayed onto the staging twin so its handlers fire here
  window.pp?.popup?.onClick((path) => {
    let n: Element | undefined = modal();
    for (const i of path) n = n?.children[i];
    n?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  // likewise a data-page-up box hitting its top (see src/popup-shell.ts) —
  // whoever rendered the box listens for pp-pageup and pages older content in
  window.pp?.popup?.onPageUp((path) => {
    let n: Element | undefined = modal();
    for (const i of path) n = n?.children[i];
    n?.dispatchEvent(new CustomEvent('pp-pageup'));
  });
}

export function openOverlay(html: string, { panel = true }: { panel?: boolean } = {}): void {
  wireOnce();
  panelMode = panel;
  popupUp = true;
  modal().innerHTML = html;
  queueMirror();
}

export function closeOverlay(): void {
  popupUp = false;
  modal().innerHTML = '';
  window.pp?.popup?.hide();
}

export function isOverlayOpen(): boolean {
  return popupUp;
}
