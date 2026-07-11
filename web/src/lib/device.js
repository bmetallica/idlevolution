// Geräte-/Orientierungs-Erkennung für die Mobile-Variante (Phase 0).
// Mobile wird strikt an einen GROBEN Zeiger (Touch) gekoppelt — NICHT an die
// Fensterbreite. So bekommt ein Maus-Desktop IMMER die unveränderte PC-Optik,
// egal wie schmal das Fenster ist. Zum Testen am PC: ?mobile=1 bzw. ?mobile=0.

import { readable, derived } from 'svelte/store';

function media(query) {
  return readable(false, (set) => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => set(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
}

// Manuelles Override per URL-Parameter (?mobile=1 / ?mobile=0).
const override = (() => {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('mobile');
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return null;
})();

const coarse = media('(pointer: coarse)');

/** Hochformat? (für den „Gerät drehen"-Hinweis) */
export const portrait = media('(orientation: portrait)');

/** true auf Touch-Primärgeräten (Handy/Tablet). Maus-Desktop = immer false. */
export const isMobile = override === null ? coarse : readable(override);

/** Querformat = spielbare Ausrichtung. */
export const isLandscape = derived(portrait, (p) => !p);
