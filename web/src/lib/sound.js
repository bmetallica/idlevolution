// D3: Synthetisierter Sound-Layer — WebAudio ohne Assets (größter Atmosphäre-
// Gewinn pro Zeile Code). Alle Klänge werden prozedural erzeugt; Mute persistiert.
// AudioContext entsteht lazy beim ersten Klang (Autoplay-Policy: Aufrufe kommen
// aus User-Gesten wie Bau-Klicks; falls doch blockiert → still scheitern).

let ctx = null;
let muted = false;
try { muted = localStorage.getItem('soundMuted') === '1'; } catch {}

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem('soundMuted', muted ? '1' : '0'); } catch {}
}

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Ton mit exponentiellem Ausklang. */
function tone(freq, { type = 'sine', dur = 0.15, peak = 0.12, delay = 0, slideTo = null } = {}) {
  const a = ac();
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  gain.gain.setValueAtTime(peak, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Kurzer Rausch-Impuls (für den Bau-Thud). */
function noise({ dur = 0.08, peak = 0.08, delay = 0 } = {}) {
  const a = ac();
  const t0 = a.currentTime + delay;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const gain = a.createGain();
  gain.gain.setValueAtTime(peak, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;
  src.connect(lp).connect(gain).connect(a.destination);
  src.start(t0);
}

const safe = (fn) => { if (muted) return; try { fn(); } catch { /* Audio blockiert → still */ } };

/** Bau/Platzierung: dumpfer Thud. */
export const sfxThud = () => safe(() => { tone(95, { dur: 0.12, peak: 0.18, slideTo: 55 }); noise({ dur: 0.07, peak: 0.1 }); });
/** Handel/Münze: zwei helle Pings. */
export const sfxCoin = () => safe(() => { tone(880, { dur: 0.07, peak: 0.08 }); tone(1318, { dur: 0.12, peak: 0.08, delay: 0.06 }); });
/** Großer Erfolg (Epochen-Aufstieg): aufsteigender Dreiklang. */
export const sfxChime = () => safe(() => { tone(523, { dur: 0.18, peak: 0.09 }); tone(659, { dur: 0.18, peak: 0.09, delay: 0.1 }); tone(784, { dur: 0.3, peak: 0.1, delay: 0.2 }); });
/** Fehler: kurzer tiefer Brummer. */
export const sfxError = () => safe(() => tone(165, { type: 'square', dur: 0.12, peak: 0.05 }));
/** Abriss: absteigendes Knirschen. */
export const sfxBreak = () => safe(() => { tone(200, { type: 'sawtooth', dur: 0.15, peak: 0.06, slideTo: 70 }); noise({ dur: 0.1, peak: 0.07 }); });
