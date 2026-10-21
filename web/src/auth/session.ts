import { useSyncExternalStore } from 'react'
import type { SessionInfo } from './api'

/**
 * The page's sign-in state, shared by AuthBar (which learns it) and the Món đặc biệt panel (which sends a solved
 * result as soon as the player is signed in, AC-DAILY-15). Only what /auth/session returns - never the cookie.
 */
let current: SessionInfo | null = null
const listeners = new Set<() => void>()

export const getCurrentSession = (): SessionInfo | null => current

export function setCurrentSession(s: SessionInfo | null): void {
  current = s
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSession = (): SessionInfo | null => useSyncExternalStore(subscribe, getCurrentSession)
