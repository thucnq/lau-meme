/**
 * mQuiz sounds and vibration (AC-QUIZ-30, AC-QUIZ-39, ADR 0023): synthesized with Web Audio, no files to load.
 * On by default; the AudioContext is created on the player's first gesture (browsers refuse to play before one).
 * The 🔊/🔇 choice also silences vibration and is kept in localStorage; a blocked storage only forgets it.
 */
import { storageKey } from '../storage'

export type Cue = 'tick' | 'right' | 'wrong' | 'final'
type Note = { type: OscillatorType; freq: number; at: number; len: number; gain: number }
type Ctor = new () => AudioContext

const KEY = storageKey('quiz:sound')

const CUES: Record<Cue, Note[]> = {
  tick: [{ type: 'square', freq: 880, at: 0, len: 0.05, gain: 0.05 }],
  right: [
    { type: 'sine', freq: 659.3, at: 0, len: 0.15, gain: 0.2 },
    { type: 'sine', freq: 987.8, at: 0.1, len: 0.3, gain: 0.2 },
  ],
  wrong: [
    { type: 'triangle', freq: 220, at: 0, len: 0.2, gain: 0.25 },
    { type: 'triangle', freq: 164.8, at: 0.15, len: 0.35, gain: 0.25 },
  ],
  final: [
    { type: 'sine', freq: 523.3, at: 0, len: 0.25, gain: 0.18 },
    { type: 'sine', freq: 659.3, at: 0.2, len: 0.25, gain: 0.18 },
    { type: 'sine', freq: 784, at: 0.4, len: 0.25, gain: 0.18 },
    { type: 'sine', freq: 1046.5, at: 0.6, len: 0.6, gain: 0.2 },
  ],
}

const audioCtor = (): Ctor | undefined => {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return w.AudioContext ?? w.webkitAudioContext
}

/** Without Web Audio the 🔊/🔇 button is hidden. */
export const soundSupported = (): boolean => typeof window !== 'undefined' && audioCtor() !== undefined

export function readSoundOn(storage: Storage | null): boolean {
  try {
    return storage?.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeSoundOn(storage: Storage | null, on: boolean): void {
  try {
    storage?.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
}

/** One player per room screen. `unlock` runs on a user gesture; `play` is silent until then. */
export function createQuizSound(): { unlock: () => void; play: (cue: Cue) => void } {
  let ctx: AudioContext | null = null
  const unlock = () => {
    try {
      if (!ctx) {
        const Ctx = audioCtor()
        if (Ctx) ctx = new Ctx()
      }
      if (ctx?.state === 'suspended') ctx.resume().catch(() => undefined)
    } catch {
      // audio refused: the game stays silent
    }
  }
  const play = (cue: Cue) => {
    try {
      const ac = ctx
      if (!ac) return
      const t0 = ac.currentTime
      for (const n of CUES[cue]) {
        const osc = ac.createOscillator()
        const amp = ac.createGain()
        osc.type = n.type
        osc.frequency.setValueAtTime(n.freq, t0 + n.at)
        amp.gain.setValueAtTime(0.0001, t0 + n.at)
        amp.gain.exponentialRampToValueAtTime(n.gain, t0 + n.at + 0.02)
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len)
        osc.connect(amp)
        amp.connect(ac.destination)
        osc.start(t0 + n.at)
        osc.stop(t0 + n.at + n.len)
      }
    } catch {
      // audio blocked mid-game: the visual feedback is enough
    }
  }
  return { unlock, play }
}

/** One short buzz when supported (Android); iOS has no vibration and ignores it. */
export function buzz(): void {
  try {
    navigator.vibrate?.(200)
  } catch {
    // not allowed here
  }
}
