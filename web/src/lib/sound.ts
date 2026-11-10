// The bell's sound, per device (localStorage `tt:sound`): off, chime or ping (default chime). Set
// under Settings → Appearance, next to the theme.
//
// The sounds are synthesized with Web Audio: no audio file to load and no change to the CSP, and
// it works over plain HTTP. Browsers only let a page make sound after you've interacted with it,
// so the audio context is started (and resumed, after a phone suspends it) on a pointerdown or
// keydown. With several tabs open, only one plays: the first tab that can play claims the newest
// notification's id in `tt:notify-last-id` ({id, at}); the others hear about it through the
// `storage` event. A claim older than CLAIM_STALE_MS no longer counts, so ids starting over after a
// restore don't keep every tab quiet.

import { useSyncExternalStore } from 'react';

export type SoundChoice = 'off' | 'chime' | 'ping';
export const SOUND_CHOICES: readonly SoundChoice[] = ['off', 'chime', 'ping'];

const KEY = 'tt:sound';
export const LAST_ID_KEY = 'tt:notify-last-id';
/** How long a tab's claim on a notification keeps the other tabs quiet. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;
const listeners = new Set<() => void>();

interface Claim {
  id: number;
  /** When it was claimed (ms). */
  at: number;
}
const NO_CLAIM: Claim = { id: 0, at: 0 };

function read(): SoundChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'off' || v === 'ping' ? v : 'chime';
  } catch {
    return 'chime';
  }
}

/** A stored claim; a bare number (an older version) counts as long ago. */
function parseClaim(raw: string | null): Claim {
  if (!raw) return NO_CLAIM;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'number') return { id: v, at: 0 };
    if (v && typeof v === 'object') {
      const { id, at } = v as Record<string, unknown>;
      if (typeof id === 'number' && typeof at === 'number') return { id, at };
    }
  } catch {
    /* not ours */
  }
  return NO_CLAIM;
}

function readClaim(): Claim {
  try {
    return parseClaim(localStorage.getItem(LAST_ID_KEY));
  } catch {
    return NO_CLAIM;
  }
}

let current: SoundChoice = read();
/** The latest claim this tab knows of (its own, or another tab's through the storage event). */
let claimed: Claim = readClaim();
let installed = false;

export function getSound(): SoundChoice {
  return current;
}

export function setSound(choice: SoundChoice): void {
  current = choice;
  try {
    if (choice === 'chime') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: still applies for this visit */
  }
  for (const l of listeners) l();
}

export function useSound(): SoundChoice {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

// ---- Web Audio ----

type AudioCtor = typeof AudioContext;
let audio: AudioContext | null = null;

function audioContext(create: boolean): AudioContext | null {
  if (audio || !create) return audio;
  const Ctor: AudioCtor | undefined =
    typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    return null;
  }
  return audio;
}

/** Starts or resumes audio inside a user gesture (the only time browsers allow it). */
function unlock(): void {
  const ctx = audioContext(true);
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}

/**
 * Call once at startup: audio is unlocked on the first pointerdown or keydown (and resumed on
 * later ones if the browser suspended it), and other tabs' sound choice and plays are followed.
 */
export function installSound(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true, passive: true });
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      current = read();
      for (const l of listeners) l();
    } else if (e.key === LAST_ID_KEY) {
      const other = parseClaim(e.newValue);
      if (other.at >= claimed.at) claimed = other;
    }
  });
}

/** One tone: a quick attack and a soft exponential fade. */
function tone(ctx: AudioContext, freq: number, start: number, duration: number, type: OscillatorType, peak: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** Whether this tab can make a sound right now: a sound chosen, and audio unlocked and running. */
export function canPlay(choice: SoundChoice = current): boolean {
  return choice !== 'off' && audio !== null && audio.state === 'running';
}

/**
 * Plays a sound now. False when it can't: 'off', no Web Audio, or audio not unlocked yet (call it
 * from a click to unlock it, as the Test button does).
 */
export function playSound(choice: SoundChoice = current, fromGesture = false): boolean {
  if (choice === 'off') return false;
  if (fromGesture) unlock();
  const ctx = audioContext(fromGesture);
  if (!ctx) return false;
  if (ctx.state !== 'running' && !fromGesture) return false;
  const t = ctx.currentTime + 0.02;
  if (choice === 'chime') {
    // Two bell-like notes, a sixth apart (A5, E6).
    tone(ctx, 880, t, 0.6, 'sine', 0.14);
    tone(ctx, 1318.5, t + 0.13, 0.8, 'sine', 0.11);
  } else {
    // One short, bright ping (A6).
    tone(ctx, 1760, t, 0.25, 'triangle', 0.12);
  }
  return true;
}

/**
 * Whether this tab plays for notification `id`: the first tab to get here claims it, so with
 * several tabs open you hear it once. Call it only when this tab can play (canPlay), so a tab that
 * can't doesn't keep the others quiet. A claim older than CLAIM_STALE_MS doesn't count.
 */
export function claimNotification(id: number, now = Date.now()): boolean {
  const blocks = (c: Claim) => c.id >= id && now - c.at < CLAIM_STALE_MS;
  if (blocks(claimed) || blocks(readClaim())) return false;
  claimed = { id, at: now };
  try {
    localStorage.setItem(LAST_ID_KEY, JSON.stringify(claimed));
  } catch {
    /* can't share it: this tab plays anyway */
  }
  return true;
}

/** Tests only: forget the in-memory state. */
export function resetSoundForTests(): void {
  current = read();
  claimed = readClaim();
  audio = null;
}
