// Shell for the popup window. It owns no behavior: the pet renderer mirrors
// its hidden #modal staging markup here (full innerHTML on every mutation),
// and every click goes back as a child-index path for the pet renderer to
// re-dispatch on the staging tree — so all popup handlers run over there,
// against the real state, unchanged.
//
// Instead of resetting innerHTML per update (which would replay entrance
// animations and drop scroll positions mid-book), incoming markup is morphed
// into the live DOM: matching nodes are patched in place, so the weave
// spinner keeps spinning and the card list keeps its scroll while text and
// classes update around them. (style.css is linked from popup.html, the same
// way index.html pulls it in.)

const root = document.getElementById('proot')!;
const shell = window.pp!.popupShell;

// ── naive DOM morph (our own markup only — no inputs, no SVG surprises) ──
function sameNode(a: Element, b: Element): boolean {
  return a.tagName === b.tagName && (a as HTMLElement).id === (b as HTMLElement).id;
}

function morphAttrs(from: Element, to: Element): void {
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}

function morphChildren(from: Element, to: Element): void {
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const cur = a[i];
    const want = b[i];
    if (!want) { cur!.remove(); continue; }
    if (!cur) { from.appendChild(want); continue; }
    if (cur.nodeType !== want.nodeType) { from.replaceChild(want, cur); continue; }
    if (cur.nodeType === Node.TEXT_NODE) {
      if (cur.textContent !== want.textContent) cur.textContent = want.textContent;
      continue;
    }
    if (cur.nodeType === Node.ELEMENT_NODE) {
      if (!sameNode(cur as Element, want as Element)) { from.replaceChild(want, cur); continue; }
      morphAttrs(cur as Element, want as Element);
      morphChildren(cur as Element, want as Element);
    }
  }
}

// ── drag regions ──
// The whole card drags the window; controls and scrollable lists opt out so
// they keep their clicks and wheel. Re-applied after every morph (morphAttrs
// rewrites the style attribute from the staging markup).
const NODRAG =
  'button, a, input, textarea, select, ' +
  '[data-tab], [data-filter], [data-apply], [data-fav], [data-del], [data-delmem], [data-pick]';

function applyDragRegions(): void {
  const region = (el: HTMLElement, v: string) => el.style.setProperty('-webkit-app-region', v);
  const top = root.firstElementChild as HTMLElement | null;
  if (!top) return;
  region(top, 'drag');
  root.querySelectorAll<HTMLElement>(NODRAG).forEach((el) => region(el, 'no-drag'));
  root.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (el.scrollHeight > el.clientHeight + 4) region(el, 'no-drag');
  });
}

function requestResize(): void {
  const top = root.firstElementChild as HTMLElement | null;
  if (!top) return;
  // offsetWidth/Height are pure layout sizes — a bounding rect here would be
  // scaled down by the pp-cardin entrance animation's transform mid-flight,
  // and the too-small window would then trap the card via its 100vw max-width
  const pad = 80; // 40px shell padding on each side (see popup.html)
  shell.resize(top.offsetWidth + pad, top.offsetHeight + pad);
}

shell.onRender((html, _panel, htmlClass) => {
  // language-dependent CSS (html.zh …) follows the pet window's root class
  document.documentElement.className = htmlClass;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(root, tpl.content as unknown as Element);
  applyDragRegions();
  requestResize();
  // content-sized cards (text on webfonts) settle once the fonts are in
  void document.fonts.ready.then(requestResize);
});

// clicks travel back as a child-index path into the mirrored markup
root.addEventListener('click', (e) => {
  let n = e.target as Element | null;
  if (!n || !root.contains(n)) return;
  const path: number[] = [];
  while (n && n !== root) {
    const parent: Element | null = n.parentElement;
    if (!parent) return;
    path.unshift([...parent.children].indexOf(n));
    n = parent;
  }
  shell.click(path);
});
