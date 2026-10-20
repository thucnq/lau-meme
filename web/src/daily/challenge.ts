import type { GraphResult } from '../graph/crypto'

/**
 * Daily challenge board (AC-DAILY-04/05): separate from the main Đĩa, starts from the 4 starters, counts every
 * combination (misses included) and survives a reload within the same batch through local storage.
 */
export type ElementRef = { id: string; name: string; emoji: string }
export type DailyInfo = { element_id: string; emoji: string; hint: string; depth: number }
export type PathStep = { a: string; b: string; result: string }

export type ChallengeState = {
  version: number
  board: ElementRef[]
  steps: number
  solved: boolean
  targetLabel: string
  path: PathStep[]
}

export type Challenge = {
  getState(): ChallengeState
  combine(a: ElementRef, b: ElementRef): Promise<{ ok: boolean; result: ElementRef | null; solved: boolean }>
  submission(): { steps: number; path: PathStep[] }
}

const STORAGE_KEY = 'lau-meme:daily-challenge'
export const HIDDEN_NAME = '???'

type Saved = { version: number; board: ElementRef[]; steps: number; solvedName: string | null; path: PathStep[] }

function load(storage: Storage | undefined, version: number): Saved | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Saved
    if (saved.version !== version || !Array.isArray(saved.board) || !Array.isArray(saved.path)) return null
    return saved
  } catch {
    return null
  }
}

function save(storage: Storage | undefined, state: Saved): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage full or blocked: the challenge still works for this page view.
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return localStorage
  } catch {
    return undefined
  }
}

/** Opens the challenge of `version`: restores it when saved for the same batch, otherwise starts a new board. */
export function openChallenge(deps: {
  version: number
  daily: DailyInfo
  starters: ElementRef[]
  lookup: (a: string, b: string) => Promise<GraphResult | null>
  onDiscover: (el: ElementRef) => void
  storage?: Storage
}): Challenge {
  const storage = deps.storage ?? defaultStorage()
  const state: Saved = load(storage, deps.version) ?? {
    version: deps.version,
    board: deps.starters.map(({ id, name, emoji }) => ({ id, name, emoji })),
    steps: 0,
    solvedName: null,
    path: [],
  }
  save(storage, state)

  return {
    getState: () => ({
      version: state.version,
      board: state.board.map((e) => ({ ...e })),
      steps: state.steps,
      solved: state.solvedName !== null,
      targetLabel: state.solvedName ?? HIDDEN_NAME,
      path: state.path.map((s) => ({ ...s })),
    }),
    async combine(a, b) {
      // Count the step only once the lookup answered, so a thrown lookup leaves state and storage untouched.
      const found = await deps.lookup(a.name, b.name)
      state.steps += 1
      if (!found) {
        save(storage, state)
        return { ok: false, result: null, solved: false }
      }
      const result: ElementRef = { id: found.id, name: found.name, emoji: found.emoji }
      if (!state.board.some((e) => e.id === result.id)) {
        state.board.push(result)
        deps.onDiscover(result)
      }
      state.path.push({ a: a.name, b: b.name, result: result.name })
      const solved = result.id === deps.daily.element_id
      if (solved) state.solvedName = result.name
      save(storage, state)
      return { ok: true, result, solved }
    },
    submission: () => ({ steps: state.steps, path: state.path.map((s) => ({ ...s })) }),
  }
}
