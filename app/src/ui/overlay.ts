// Overlay / popup plumbing: the fullscreen-window modal choreography, the
// draggable popup wrapper, and open/close for everything rendered into #modal.

export const overlay = () => document.getElementById('overlay')!;
export const modal = () => document.getElementById('modal')!;

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

const stageEl = () => document.getElementById('stage')!;
const panelEl = () => document.getElementById('hoverpanel')!;

// ── modal window choreography ──
// The pet window is small and sits wherever the user dragged the potato; a
// modal expands it to the full work area so the popup can center on screen.
// The stage is anchored right/bottom INSIDE the window, so the resize alone
// would teleport the potato to the screen corner. Instead of hiding him
// (earlier fix — he vanished for the whole modal), offset the stage by the
// window→work-area edge gap so he holds his exact on-screen spot, and order
// each step around actual paints/resizes so no frame catches him mid-jump.
let modalUp = false;
let modalSeq = 0; // open/close generation — stale async steps bail out

const painted = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const resizedOrTimeout = (ms: number) =>
  new Promise<void>((r) => {
    const done = () => { clearTimeout(t); window.removeEventListener('resize', done); r(); };
    const t = setTimeout(done, ms);
    window.addEventListener('resize', done, { once: true });
  });

async function expandForModal(seq: number): Promise<void> {
  const g = await (window.pp?.win?.modalGeometry?.() ?? null);
  if (seq !== modalSeq) return;
  if (g) {
    const st = stageEl().style;
    // the stage's resting right offset is %-based (centered in the window), so
    // measure the pixel gap before the resize and pin it as an absolute value.
    // If a still-closing overlay left the stage pinned (release() skipped by
    // the seq bump), those values are already right for this window — measuring
    // again from them would double-count the offset.
    if (!st.bottom) {
      const baseRight = window.innerWidth - stageEl().getBoundingClientRect().right;
      st.right = `${baseRight + g.dx}px`;
      st.bottom = `${g.dy}px`;
    }
    // Transparent windows get no synchronized resize on macOS: the window
    // server can flash the pre-resize frame stretched into the new bounds,
    // teleporting the potato toward the screen center for a beat. Blink him
    // out so the stale frame is potato-free, and bring him back only after
    // the resized window has painted the new layout.
    st.visibility = 'hidden';
    await painted(); // the offset (hidden) stage is committed before the window grows
    if (seq !== modalSeq) return;
    window.pp!.win.setModal(true);
    await resizedOrTimeout(250); // and the popup only shows once it can center
    if (seq !== modalSeq) return;
    await painted(); // first full-size frame is up — safe to show him again
    if (seq !== modalSeq) return;
    st.visibility = '';
  }
  overlay().classList.remove('hidden');
}

// ── draggable popups ──
// Offset #modal (the popup wrapper) with a transform; #overlay's flex keeps it
// centered, so the transform is a pure delta from center. Grab any non-control
// part of a popup to drag it anywhere; buttons, inputs and cards keep their own
// clicks. isDraggingModal() lets the app hold the window mouse-active mid-drag.
let dragOff = { x: 0, y: 0 };
let draggingModal = false;
export function isDraggingModal(): boolean {
  return draggingModal;
}
function resetModalDrag(): void {
  dragOff = { x: 0, y: 0 };
  modal().style.transform = '';
}
function initModalDrag(): void {
  const m = modal();
  if (m.dataset.dragInit) return; // #modal persists across popups — wire once
  m.dataset.dragInit = '1';
  let from: { x: number; y: number; ox: number; oy: number } | null = null;
  const NODRAG = 'button, input, textarea, select, a, [data-apply], [data-pick]';
  m.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest(NODRAG)) return;
    from = { x: e.clientX, y: e.clientY, ox: dragOff.x, oy: dragOff.y };
    draggingModal = true;
    m.classList.add('dragging');
    m.setPointerCapture(e.pointerId);
  });
  m.addEventListener('pointermove', (e) => {
    if (!from) return;
    dragOff = { x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) };
    m.style.transform = `translate(${dragOff.x}px, ${dragOff.y}px)`;
  });
  const end = (e: PointerEvent) => {
    if (!from) return;
    from = null;
    draggingModal = false;
    m.classList.remove('dragging');
    try { m.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  m.addEventListener('pointerup', end);
  m.addEventListener('pointercancel', end);
}

// Every popup floats over the live desktop — no dim backdrop, and the area
// around it stays click-through (see the mousemove handler in interactions.ts)
// so the rest of the screen stays usable. `panel` stays a hook (pass false for
// a dim, blocking modal) but every popup now defaults to the floating,
// draggable look.
export function openOverlay(html: string, { panel = true }: { panel?: boolean } = {}): void {
  initModalDrag();
  modal().innerHTML = html;
  overlay().classList.toggle('panel', panel);
  if (modalUp) { overlay().classList.remove('hidden'); return; } // draw → weave → card chain: window already big
  modalUp = true;
  resetModalDrag(); // a fresh popup opens centered, not where the last was left
  // Hide the hover panel instantly. It's anchored bottom:78px INSIDE the window
  // but isn't offset like the stage, so when the window expands to fullscreen it
  // reflows to the taller window's bottom and visibly drops for a beat before the
  // dim overlay covers it. It sits behind the dim anyway, so just take it out.
  panelEl().classList.remove('show');
  panelEl().classList.add('hidden');
  expandForModal(++modalSeq);
}

export function closeOverlay(): void {
  const seq = ++modalSeq;
  modalUp = false;
  overlay().classList.add('hidden');
  overlay().classList.remove('panel');
  modal().innerHTML = '';
  resetModalDrag();
  // Blink the potato out for the shrink, mirroring expandForModal: the
  // window-server may briefly show the stale fullscreen frame in the restored
  // bounds, and a hidden stage keeps that frame potato-free. The shrink is
  // only requested once the hidden-stage frame has actually painted.
  stageEl().style.visibility = 'hidden';
  void (async () => {
    await painted();
    if (seq !== modalSeq) return; // a reopen raced in — it owns the window now
    window.pp?.win?.setModal(false);
  })();
  // release the stage offset only after the window is small again — resetting
  // early would flash the potato at the fullscreen corner for a frame
  const release = () => {
    if (seq !== modalSeq) return;
    const st = stageEl().style;
    st.right = '';
    st.bottom = '';
    st.visibility = '';
    panelEl().classList.remove('hidden'); // back to hover-gated (stays hidden until next hover)
  };
  window.addEventListener('resize', () => requestAnimationFrame(release), { once: true });
  setTimeout(release, 300); // fallback if no resize event fires
}

export function isOverlayOpen(): boolean {
  return !overlay().classList.contains('hidden');
}

// While a popup holds the window fullscreen a potato drag can't move the
// window, so it shifts the pinned stage offsets instead — the matching window
// delta is banked into the main process's saved bounds via move-by, and the
// potato comes back at the dropped spot when the popup closes.
export function nudgeModalStage(dx: number, dy: number): void {
  const st = stageEl().style;
  if (!modalUp || !st.bottom) return; // window not expanded (or stage not pinned yet)
  st.right = `${parseFloat(st.right) - dx}px`;
  st.bottom = `${parseFloat(st.bottom) - dy}px`;
}
