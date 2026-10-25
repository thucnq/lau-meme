/**
 * Short sounds for a first Vàng/Đỏ discovery (AC-GAME-26, ADR 0017): synthesized with Web Audio, no files to load.
 * The AudioContext is created on the first sound, which always follows a player combine, never on page load.
 * A browser that refuses audio (constructor throws, resume rejects) is ignored quietly.
 */
type Note = { type: OscillatorType; freq: number; to?: number; at: number; len: number; gain: number }

// Vàng: a bright two-note chime. Đỏ: a low boom under a rising three-note fanfare. Everything ends within 2 s.
const GOLD: Note[] = [
  { type: 'sine', freq: 1318.5, at: 0, len: 0.35, gain: 0.25 },
  { type: 'sine', freq: 1975.5, at: 0.12, len: 0.5, gain: 0.2 },
]
const RED: Note[] = [
  { type: 'triangle', freq: 110, to: 55, at: 0, len: 0.6, gain: 0.4 },
  { type: 'sawtooth', freq: 523.3, at: 0.1, len: 0.3, gain: 0.08 },
  { type: 'sawtooth', freq: 659.3, at: 0.25, len: 0.3, gain: 0.08 },
  { type: 'square', freq: 784, at: 0.4, len: 0.7, gain: 0.07 },
]

type Ctor = new () => AudioContext

/** One player per game screen; its AudioContext is created on the first sound. */
export function createTierSound(): (tier: 4 | 5) => void {
  let ctx: AudioContext | null = null
  const context = (): AudioContext | null => {
    if (ctx) return ctx
    const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
    const Ctx = w.AudioContext ?? w.webkitAudioContext
    if (Ctx) ctx = new Ctx()
    return ctx
  }
  return (tier) => {
    try {
      const ac = context()
      if (!ac) return
      if (ac.state === 'suspended') ac.resume().catch(() => undefined)
      const t0 = ac.currentTime
      for (const n of tier === 5 ? RED : GOLD) {
        const osc = ac.createOscillator()
        const amp = ac.createGain()
        osc.type = n.type
        osc.frequency.setValueAtTime(n.freq, t0 + n.at)
        if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.len)
        amp.gain.setValueAtTime(0.0001, t0 + n.at)
        amp.gain.exponentialRampToValueAtTime(n.gain, t0 + n.at + 0.02)
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len)
        osc.connect(amp).connect(ac.destination)
        osc.start(t0 + n.at)
        osc.stop(t0 + n.at + n.len)
      }
    } catch {
      // audio blocked or unsupported: the visual effect is enough
    }
  }
}
