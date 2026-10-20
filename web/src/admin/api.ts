/**
 * Admin API client (ADR 0008): the page is always served at `/` of the admin origin, so the relative `api/admin/*`
 * resolves to `/api/admin/*` there (no game base path; the build never holds a root `/api/` path - AC-SUBPATH-07).
 * The token only ever goes into the Authorization header of these requests.
 */
export type State = 'active' | 'hidden' | 'blocked'
export type Kind = 'element' | 'recipe' | 'image'
export type Action = 'hide' | 'show' | 'block' | 'unblock' | 'dismiss_reports'
export type Page<T> = { page: number; size: number; total: number; items: T[] }
export type Ref = { id: string; name: string; emoji: string }

export type ReportItem = Ref & {
  target: 'element' | 'image'
  reporters: number
  reasons: Record<string, number>
  last_reported_at: string
  state: State
}
export type ElementItem = Ref & {
  depth: number
  state: State
  image_key: string | null
  image_state: 'none' | 'active' | 'hidden'
  last_version: number
}
export type RecipeItem = { id: string; a: Ref; b: Ref; result: Ref; state: 'active' | 'hidden' }
export type BatchItem = {
  id: string
  version: number | null
  batch_at: string
  mode: 'core' | 'full'
  status: 'success' | 'error' | 'rollback'
  failed_step?: string | null
  rollback_to?: number | null
  stats: { added?: number; blocked?: Record<string, number>; queued?: number; source_errors?: { source: string; error: string }[] }
  issue_url?: string | null
  created_at: string
}
export type AuditItem = {
  action: Action
  target_kind: Kind
  target_id: string
  before: State
  after: State
  reason?: string | null
  token_fp: string
  created_at: string
}

/** 401: the token is wrong (or was rotated) - the page drops it and asks again. */
export class AuthError extends Error {}
/** 429 after too many wrong tokens from this IP (AC-ADMIN-02). */
export class LockedError extends Error {
  constructor(readonly retryAfter: number) {
    super('locked')
  }
}
/** Any other failure; `title` is the problem+json title when the server sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
  ) {
    super(title)
  }
}

export async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`api/admin/${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (res.status === 401) throw new AuthError('unauthorized')
  if (res.status === 429) throw new LockedError(Number(res.headers.get('Retry-After')) || 900)
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { title?: string; detail?: string } | null
    throw new ApiError(res.status, problem?.detail ?? problem?.title ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export const moderate = (token: string, target_kind: Kind, target_id: string, action: Action, reason: string) =>
  call<{ before: State; after: State }>(token, 'moderation', {
    method: 'POST',
    body: { target_kind, target_id, action, ...(reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}) },
  })
