// One-shot celebration effects layered over the stage.

export function confettiBurst(): void {
  const host = document.getElementById('confetti')!;
  const colors = ['#E08A3C', '#C9A227', '#7E9469', '#C97B8E', '#6E86A8'];
  for (let i = 0; i < 18; i++) {
    const c = document.createElement('span');
    c.className = 'c';
    c.style.left = `${6 + Math.random() * 88}%`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dur', `${1.6 + Math.random() * 1.2}s`);
    c.style.setProperty('--delay', `${Math.random() * 0.5}s`);
    host.appendChild(c);
    setTimeout(() => c.remove(), 3800);
  }
}

export function heartsBurst(): void {
  const host = document.getElementById('hearts')!;
  const h = document.createElement('span');
  h.className = 'h';
  h.style.left = `${25 + Math.random() * 50}%`;
  h.style.fontSize = `${14 + Math.random() * 10}px`;
  h.textContent = '♥';
  host.appendChild(h);
  setTimeout(() => h.remove(), 950);
}
