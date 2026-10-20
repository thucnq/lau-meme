/**
 * The game lives under a sub-path of dinoduct.fun (ADR 0007). Every URL the app requests or shares goes through here;
 * the prefix itself comes from base-path.json via Vite's `base`.
 */

/** `path` (with or without a leading "/") under the game's base path, e.g. "api/health" → "/lau-meme/api/health". */
export function withBase(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, '')
}

/** Absolute public URL of the game (canonical, OG tags, share links). */
export const SITE_URL: string = import.meta.env.VITE_SITE_URL

/** Link put on share cards (AC-SHARE): the game's home page tagged with where the visitor came from. */
export function shareUrl(ref: string): string {
  return `${SITE_URL}?ref=${encodeURIComponent(ref)}`
}
