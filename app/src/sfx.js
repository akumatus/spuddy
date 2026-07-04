// Soft synth sounds per the design spec: every motion pairs a soft synth sound.
let audio = null;
let enabled = true;

export function setSoundEnabled(v) {
  enabled = v;
}

function ac() {
  if (!audio) {
    try {
      audio = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
  }
  if (audio && audio.state === 'suspended') audio.resume();
  return audio;
}

function tone(f0, f1, dur, type = 'sine', vol = 0.12, when = 0) {
  const ctx = ac();
  if (!ctx || !enabled) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const sfx = {
  pop: () => tone(420, 190, 0.1, 'sine', 0.14),
  boing: () => tone(240, 90, 0.2, 'triangle', 0.13),
  draw: () => {
    tone(500, 900, 0.16, 'sine', 0.07);
    tone(300, 620, 0.2, 'sine', 0.05, 0.05);
  },
  chime: () => {
    tone(660, 660, 0.22, 'sine', 0.09);
    tone(880, 880, 0.3, 'sine', 0.09, 0.13);
    tone(1100, 1100, 0.36, 'sine', 0.07, 0.28);
  },
  low: () => tone(220, 160, 0.4, 'sine', 0.07),
  // turn 7 · soul engine (design t7Sfx map)
  knock: () => {
    tone(195, 140, 0.05, 'square', 0.07);
    tone(175, 120, 0.05, 'square', 0.07, 0.12);
  },
  whoosh: () => tone(680, 180, 0.3, 'sine', 0.05),
  sneeze: () => tone(880, 210, 0.16, 'triangle', 0.11),
  catch: () => tone(300, 250, 0.06, 'sine', 0.045),
};
