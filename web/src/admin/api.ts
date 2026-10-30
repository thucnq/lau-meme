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
  /** AC-DAILY-19: món admin chỉ định đã dùng hay bị bỏ; vắng = mẻ không có chỉ định. */
  daily_pin?: 'used' | 'dropped'
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
  /** Trạng thái kiểm duyệt, hoặc object (tier, ảnh, đề xuất, chỉ định Món đặc biệt), hoặc null (chưa/không còn chỉ định). */
  before: State | Record<string, unknown> | null
  after: State | Record<string, unknown> | null
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
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** AC-ADMIN-12, AC-TIER-05: `auto` bỏ giá trị admin gán, phần tử quay về tier theo độ sâu. */
export const setTier = (token: string, id: string, tier: number | 'auto') =>
  call<{ before: number; after: number }>(token, `elements/${id}/tier`, { method: 'PUT', body: { tier } })

/** AC-ART-13: tranh vẽ tay đã chuẩn hóa về WebP 256×256 (`drawing.ts`). */
export const setImage = (token: string, id: string, webp: Blob) =>
  call<{ element_id: string; before_key: string | null; after_key: string }>(token, `elements/${id}/image`, { method: 'PUT', webp })

/** Món đặc biệt admin chỉ định cho mẻ kế tiếp (AC-DAILY-19, ADR 0019). */
export type DailyPin = { element_id: string; name: string; emoji: string; hint: string; created_at: string }

export const getDailyPin = (token: string) => call<{ pin: DailyPin | null }>(token, 'daily-pin')
export const setDailyPin = (token: string, element_id: string, hint: string) =>
  call<{ before: DailyPin | null; after: DailyPin }>(token, 'daily-pin', { method: 'PUT', body: { element_id, hint } })
export const clearDailyPin = (token: string) => call<undefined>(token, 'daily-pin', { method: 'DELETE' })

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
  use_image_url?: boolean
  tier: number
  element_id: string | null
  in_catalog: boolean
  nickname: string
  created_at: string
  decided_at: string | null
}
export type ContributionEdit = Partial<Pick<ContributionItem, 'name' | 'emoji' | 'description' | 'image_url'>>

export const editContribution = (token: string, id: string, body: ContributionEdit) =>
  call<ContributionItem>(token, `contributions/${id}`, { method: 'PATCH', body })

/** `useLink` (AC-ART-14): the pipeline fetches the proposal's image link in the next full batch; sent only when chosen. */
export const approveContribution = (token: string, id: string, image_hint: string, tier: number, useLink = false) =>
  call<ContributionItem>(token, `contributions/${id}/approve`, {
    method: 'POST',
    body: useLink ? { image_hint, tier, use_image_url: true } : { image_hint, tier },
  })

export const rejectContribution = (token: string, id: string, reason: string) =>
  call<ContributionItem>(token, `contributions/${id}/reject`, { method: 'POST', body: { reason } })

/** "Bị chặn" (AC-ADMIN-13..15, ADR 0022): a concept the pipeline blocked at moderation. */
export type RejectedStatus = 'blocked' | 'unblocked' | 'added' | 'approved'
export type RejectedItem = {
  id: string
  name: string
  emoji: string | null
  description: string | null
  daily_hint: string | null
  image_hint: string | null
  source_name: string
  source_url: string | null
  context: string | null
  reasons: { code: string; label: string }[]
  step: 'layer1' | 'layer2'
  status: RejectedStatus
  seen_count: number
  first_seen_at: string
  last_seen_at: string
  element_id: string | null
  a: string | null
  b: string | null
  tier: number | null
}
export type RejectedText = Partial<Record<'name' | 'emoji' | 'description' | 'daily_hint' | 'image_hint', string | null>>
export type RejectedApproval = { a: string; b: string; name: string; emoji: string; description?: string; daily_hint?: string; image_hint?: string }

export const getRejected = (token: string, id: string) => call<RejectedItem>(token, `rejected/${id}`)
export const editRejected = (token: string, id: string, body: RejectedText) =>
  call<RejectedItem>(token, `rejected/${id}`, { method: 'PATCH', body })
export const unblockRejected = (token: string, id: string) => call<RejectedItem>(token, `rejected/${id}/unblock`, { method: 'POST', body: {} })
export const approveRejected = (token: string, id: string, body: RejectedApproval) =>
  call<RejectedItem>(token, `rejected/${id}/approve`, { method: 'POST', body })

/** A live element as the "Nội dung" form edits it (AC-ADMIN-16): `edit` holds only the fields the admin changed. */
export type ElementText = { name: string; emoji: string; description: string | null; daily_hint: string | null; image_hint: string | null; origin: 'vn' | 'intl' | null }
export type ElementEdit = Partial<{ [K in keyof ElementText]: ElementText[K] | null }>
export type ElementDetail = { id: string; published: ElementText; edit: ElementEdit | null; pending: boolean; aliases: string[] }

export const getElement = (token: string, id: string) => call<ElementDetail>(token, `elements/${id}`)
export const editElement = (token: string, id: string, body: ElementEdit) =>
  call<ElementDetail>(token, `elements/${id}`, { method: 'PATCH', body })
