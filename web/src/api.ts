import { withBase } from './base'
import type { Graph } from './graph/crypto'
import type { Blocklist, Manifest } from './game/engine'

export type Health = { status: string; env: string; schema: string | null }

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withBase(url), { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export const getHealth = (signal?: AbortSignal) => getJson<Health>('api/health', signal)
export const getManifest = (signal?: AbortSignal) => getJson<Manifest>('api/manifest', signal)
/** `url` is manifest.graph_url, relative to the base path (ADR 0007). */
export const getGraph = (url: string, signal?: AbortSignal) => getJson<Graph>(url, signal)
export const getBlocklist = (signal?: AbortSignal) => getJson<Blocklist>('api/blocklist', signal)
