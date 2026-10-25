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
  tier: number
  tier_source: 'auto' | 'admin'
  /** Tier tự động của mẻ gần nhất (AC-TIER-04); null = mẻ trước TIER-04. */
  auto_tier: number | null
  /** Ai làm ra ảnh: Workers AI hay admin tải tay (AC-ART-13); null = không có ảnh hoặc mẻ trước cột này. */
  image_source?: 'ai' | 'admin' | null
}
export type RecipeItem = { id: string; a: Ref; b: Ref; result: Ref; state: 'active' | 'hidden' }
/** Số liệu do pipeline gửi kèm nhật ký đợt (BatchStats, AC-ADMIN-11): nguồn lỗi có `error` và `concepts` null. */
export type BatchStats = {
  crawled?: number
  added?: number
  blocked?: Record<string, number>
  queued?: number
  queue_size?: number
  quota_used?: number
  source_errors?: { source: string; error: string }[]
  sources?: { source: string; concepts: number | null; error: string | null }[]
  images?: { drawn: number; fallback: number; pending: number }
  without_image?: number
}
export type BatchSummary = { crawled_total: number; added_total: number; queue_size: number | null; without_image: number | null }
export type BatchItem = {
  id: string
  version: number | null
  batch_at: string
  mode: 'core' | 'full'
  status: 'success' | 'error' | 'rollback'
  failed_step?: string | null
  rollback_to?: number | null
  stats: BatchStats
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

/** `body` is sent as JSON; `webp` as the raw image (AC-ART-13). */
export async function call<T>(token: string, path: string, init: { method?: string; body?: unknown; webp?: Blob } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (init.webp) headers['Content-Type'] = 'image/webp'
  else if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`api/admin/${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.webp ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  })
  if (res.status === 401) throw new AuthError('unauthorized')
  if (res.status === 429) throw new LockedError(Number(res.headers.get('Retry-After')) || 900)
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { title?: string; detail?: string } | null
    throw new ApiError(res.status, problem?.detail ?? problem?.title ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/** AC-ADMIN-12, AC-TIER-05: `auto` bỏ giá trị admin gán, phần tử quay về tier theo độ sâu. */
export const setTier = (token: string, id: string, tier: number | 'auto') =>
  call<{ before: number; after: number }>(token, `elements/${id}/tier`, { method: 'PUT', body: { tier } })

/** AC-ART-13: tranh vẽ tay đã chuẩn hóa về WebP 256×256 (`drawing.ts`). */
export const setImage = (token: string, id: string, webp: Blob) =>
  call<{ element_id: string; before_key: string | null; after_key: string }>(token, `elements/${id}/image`, { method: 'PUT', webp })

export const moderate = (token: string, target_kind: Kind, target_id: string, action: Action, reason: string) =>
  call<{ before: State; after: State }>(token, 'moderation', {
    method: 'POST',
    body: { target_kind, target_id, action, ...(reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}) },
  })

/** A meme proposal as the admin sees it (AC-CONTRIB-07): `image_url` is only ever shown as text. */
export type ContributionStatus = 'pending' | 'approved' | 'rejected'
export type ContributionItem = {
  id: string
  a: Ref
  b: Ref
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  status: ContributionStatus
  reject_reason: string | null
  image_hint: string | null
  tier: number
  element_id: string | null
  nickname: string
  created_at: string
  decided_at: string | null
}
export type ContributionEdit = Partial<Pick<ContributionItem, 'name' | 'emoji' | 'description' | 'image_url'>>

export const editContribution = (token: string, id: string, body: ContributionEdit) =>
  call<ContributionItem>(token, `contributions/${id}`, { method: 'PATCH', body })

export const approveContribution = (token: string, id: string, image_hint: string, tier: number) =>
  call<ContributionItem>(token, `contributions/${id}/approve`, { method: 'POST', body: { image_hint, tier } })

export const rejectContribution = (token: string, id: string, reason: string) =>
  call<ContributionItem>(token, `contributions/${id}/reject`, { method: 'POST', body: { reason } })
