import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  ApiError,
  AuthError,
  approveContribution,
  editContribution,
  rejectContribution,
  setImage,
  setTier,
  LockedError,
  call,
  moderate,
  type Action,
  type AuditItem,
  type BatchItem,
  type BatchStats,
  type BatchSummary,
  type ContributionEdit,
  type ContributionItem,
  type ContributionStatus,
  type ElementItem,
  type Kind,
  type Page,
  type RecipeItem,
  type ReportItem,
} from './api'
import { withBase } from '../base'
import { DRAWING_TYPES, DrawingError, drawingProblem, toWebp256 } from './drawing'

/**
 * Trang quản trị (AC-ADMIN-10, ADR 0008). Runs on its own origin; the token lives only in this tab's
 * sessionStorage (gone when the tab closes) - never localStorage or a cookie.
 */
export const TOKEN_KEY = 'laumeme-admin.token'

function session(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

const readToken = () => session()?.getItem(TOKEN_KEY) ?? null

function errorText(err: unknown): string {
  if (err instanceof AuthError) return 'Token không đúng.'
  if (err instanceof LockedError) return `Thử sai quá nhiều lần. Thử lại sau ${Math.ceil(err.retryAfter / 60)} phút.`
  if (err instanceof ApiError) return err.title
  return 'Không kết nối được máy chủ.'
}

export function AdminApp() {
  const [token, setToken] = useState<string | null>(readToken)
  const [notice, setNotice] = useState<string | null>(null)

  const signIn = (value: string) => {
    session()?.setItem(TOKEN_KEY, value)
    setNotice(null)
    setToken(value)
  }
  // stable: the list effects depend on it
  const signOut = useCallback((message: string | null) => {
    session()?.removeItem(TOKEN_KEY)
    setNotice(message)
    setToken(null)
  }, [])
  const onAuthError = useCallback(() => signOut('Token không đúng hoặc đã đổi. Đăng nhập lại.'), [signOut])

  if (token === null) return <Login onSignIn={signIn} notice={notice} />
  return <Console token={token} onAuthError={onAuthError} onSignOut={() => signOut(null)} />
}

function Login({ onSignIn, notice }: { onSignIn: (token: string) => void; notice: string | null }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(notice)
  const [busy, setBusy] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const token = value.trim()
    if (!token) return
    setBusy(true)
    setError(null)
    call<Page<ReportItem>>(token, 'reports?status=new').then(
      () => onSignIn(token),
      (err: unknown) => {
        setBusy(false)
        setError(errorText(err))
      },
    )
  }

  return (
    <main className="admin admin-login">
      <h1>Lẩu Meme - Quản trị</h1>
      <form onSubmit={submit}>
        <label>
          Token quản trị
          <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          Đăng nhập
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  )
}

const TABS = ['Báo cáo', 'Nội dung', 'Đề xuất meme', 'Đợt + Audit'] as const
type Tab = (typeof TABS)[number]
type Ctx = { token: string; onAuthError: () => void }

function Console({ token, onAuthError, onSignOut }: Ctx & { onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('Báo cáo')
  const ctx = { token, onAuthError }
  return (
    <main className="admin">
      <header className="admin-bar">
        <h1>Lẩu Meme - Quản trị</h1>
        <button type="button" onClick={onSignOut}>
          Đăng xuất
        </button>
      </header>
      <div role="tablist" className="admin-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <section role="tabpanel" aria-label={tab}>
        {tab === 'Báo cáo' && <ReportsTab {...ctx} />}
        {tab === 'Nội dung' && <ContentTab {...ctx} />}
        {tab === 'Đề xuất meme' && <ContributionsTab {...ctx} />}
        {tab === 'Đợt + Audit' && <LogsTab {...ctx} />}
      </section>
    </main>
  )
}

/** GET one admin list; reloads when `path` or `reload` changes; a 401 signs out. */
function useList<T, Extra = unknown>({ token, onAuthError }: Ctx, path: string | null, reload: number) {
  const [data, setData] = useState<(Page<T> & Extra) | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (path === null) return
    let live = true
    call<Page<T> & Extra>(token, path).then(
      (d) => {
        if (!live) return
        setData(d)
        setError(null)
      },
      (err: unknown) => {
        if (!live) return
        if (err instanceof AuthError) onAuthError()
        else setError(errorText(err))
      },
    )
    return () => {
      live = false
    }
  }, [token, path, reload, onAuthError])
  return { data, error }
}

/** Runs a moderation command, then `done`; the reason box is shared by every button of a tab. */
function useModerate({ token, onAuthError }: Ctx, done: () => void) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = (kind: Kind, id: string, action: Action) => {
    setError(null)
    moderate(token, kind, id, action, reason).then(
      () => {
        setReason('')
        done()
      },
      (err: unknown) => (err instanceof AuthError ? onAuthError() : setError(errorText(err))),
    )
  }
  const reasonBox = (
    <label className="admin-reason">
      Lý do (tùy chọn)
      <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
    </label>
  )
  return { run, reasonBox, error }
}

function Pager({ page, onPage }: { page: Page<unknown> | null; onPage: (n: number) => void }) {
  if (!page) return null
  const last = Math.max(1, Math.ceil(page.total / page.size))
  return (
    <nav className="admin-pager" aria-label="Phân trang">
      <button type="button" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>
        Trước
      </button>
      <span>
        Trang {page.page}/{last} · {page.total} mục
      </span>
      <button type="button" disabled={page.page >= last} onClick={() => onPage(page.page + 1)}>
        Sau
      </button>
    </nav>
  )
}

const when = (iso: string) => new Date(iso).toLocaleString('vi-VN')
const STATE_LABEL = { active: 'đang hiện', hidden: 'đang ẩn', blocked: 'đã chặn', none: 'không có' } as const

function Alert({ children }: { children: ReactNode }) {
  return children ? <p role="alert">{children}</p> : null
}

function ReportsTab(ctx: Ctx) {
  const [status, setStatus] = useState<'new' | 'resolved'>('new')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const { data, error } = useList<ReportItem>(ctx, `reports?status=${status}&page=${page}`, reload)
  const mod = useModerate(ctx, () => setReload((n) => n + 1))
  return (
    <>
      <div className="admin-filters">
        <label>
          Trạng thái
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as 'new' | 'resolved')
              setPage(1)
            }}
          >
            <option value="new">Mới</option>
            <option value="resolved">Đã xử lý</option>
          </select>
        </label>
        {mod.reasonBox}
      </div>
      <Alert>{error ?? mod.error}</Alert>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Đích</th>
            <th>Số người báo cáo</th>
            <th>Lý do</th>
            <th>Gần nhất</th>
            <th>Trạng thái</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((r) => (
            <tr key={`${r.target}:${r.id}`}>
              <td>
                {r.emoji} {r.name} {r.target === 'image' && '(ảnh)'}
              </td>
              <td>{r.reporters}</td>
              <td>
                {Object.entries(r.reasons)
                  .map(([k, n]) => `${k} × ${n}`)
                  .join(', ')}
              </td>
              <td>{when(r.last_reported_at)}</td>
              <td>{STATE_LABEL[r.state]}</td>
              <td>
                {r.state === 'active' && (
                  <button type="button" onClick={() => mod.run(r.target, r.id, 'hide')}>
                    Ẩn
                  </button>
                )}
                {r.state === 'hidden' && (
                  <button type="button" onClick={() => mod.run(r.target, r.id, 'show')}>
                    Hiện
                  </button>
                )}
                {status === 'new' && (
                  <button type="button" onClick={() => mod.run(r.target, r.id, 'dismiss_reports')}>
                    Bỏ qua
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 && <p>Không có báo cáo.</p>}
      <Pager page={data} onPage={setPage} />
    </>
  )
}

const CONTRIB_SIZE = 20
const CONTRIB_STATUS: Array<[ContributionStatus, string]> = [
  ['pending', 'Chờ duyệt'],
  ['approved', 'Đã duyệt'],
  ['rejected', 'Bị từ chối'],
]
const EDIT_FIELDS = [
  ['name', 'Tên meme'],
  ['emoji', 'Biểu tượng'],
  ['description', 'Mô tả'],
  ['image_url', 'Link ảnh'],
] as const
type EditField = (typeof EDIT_FIELDS)[number][0]
type Open = { id: string; mode: 'edit' | 'approve' | 'reject' }

/**
 * "Đề xuất meme" (AC-CONTRIB-07/08): oldest first, filtered by status. Edit sends only the changed fields; approve
 * needs the image hint the illustration is drawn from; reject needs a reason. The image link is plain text - the
 * page never loads it.
 */
function ContributionsTab(ctx: Ctx) {
  const [status, setStatus] = useState<ContributionStatus>('pending')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const { data, error } = useList<ContributionItem>(ctx, `contributions?status=${status}&page=${page}&size=${CONTRIB_SIZE}`, reload)
  const [open, setOpen] = useState<Open | null>(null)
  const [draft, setDraft] = useState<Record<EditField, string>>({ name: '', emoji: '', description: '', image_url: '' })
  const [hint, setHint] = useState('')
  const [tier, setTierValue] = useState(1)
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const start = (c: ContributionItem, mode: Open['mode']) => {
    setOpen({ id: c.id, mode })
    setActionError(null)
    setDraft({ name: c.name, emoji: c.emoji ?? '', description: c.description ?? '', image_url: c.image_url ?? '' })
    setHint('')
    setTierValue(1)
    setReason('')
  }
  const run = (task: Promise<unknown>) =>
    task.then(
      () => {
        setOpen(null)
        setReload((n) => n + 1)
      },
      (err: unknown) => (err instanceof AuthError ? ctx.onAuthError() : setActionError(errorText(err))),
    )
  const save = (c: ContributionItem) => {
    const body: ContributionEdit = {}
    for (const [key] of EDIT_FIELDS) {
      const value = draft[key].trim()
      const before = c[key] ?? ''
      if (value === before) continue
      if (key === 'name') body.name = value
      else body[key] = value === '' ? null : value // an emptied optional field is cleared
    }
    if (Object.keys(body).length === 0) return setOpen(null)
    void run(editContribution(ctx.token, c.id, body))
  }

  const form = (c: ContributionItem) => {
    if (open?.id !== c.id) return null
    if (open.mode === 'edit')
      return (
        <form className="admin-inline" onSubmit={(e: FormEvent) => (e.preventDefault(), save(c))}>
          {EDIT_FIELDS.map(([key, label]) => (
            <label key={key}>
              {label}
              <input value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
            </label>
          ))}
          <button type="submit">Lưu</button>
          <button type="button" onClick={() => setOpen(null)}>
            Hủy
          </button>
        </form>
      )
    if (open.mode === 'approve')
      return (
        <form
          className="admin-inline"
          onSubmit={(e: FormEvent) => (e.preventDefault(), void run(approveContribution(ctx.token, c.id, hint.trim(), tier)))}
        >
          <label>
            Gợi ý ảnh
            <textarea value={hint} maxLength={300} onChange={(e) => setHint(e.target.value)} />
          </label>
          <label>
            Tier
            <select value={tier} onChange={(e) => setTierValue(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Xác nhận duyệt</button>
          <button type="button" onClick={() => setOpen(null)}>
            Hủy
          </button>
        </form>
      )
    return (
      <form
        className="admin-inline"
        onSubmit={(e: FormEvent) => (e.preventDefault(), void run(rejectContribution(ctx.token, c.id, reason.trim())))}
      >
        <label>
          Lý do
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="submit">Xác nhận từ chối</button>
        <button type="button" onClick={() => setOpen(null)}>
          Hủy
        </button>
      </form>
    )
  }

  return (
    <>
      <div className="admin-filters">
        <label>
          Trạng thái
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ContributionStatus)
              setPage(1)
              setOpen(null)
            }}
          >
            {CONTRIB_STATUS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Alert>{error ?? actionError}</Alert>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Cặp</th>
            <th>Đề xuất</th>
            <th>Mô tả</th>
            <th>Link ảnh</th>
            <th>Người gửi</th>
            <th>Gửi lúc</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((c) => (
            <tr key={c.id}>
              <td>
                {c.a.emoji} {c.a.name} + {c.b.emoji} {c.b.name}
              </td>
              <td>
                {c.emoji ?? ''} {c.name}
                {c.status === 'approved' && ` (tier ${c.tier})`}
                {c.reject_reason && ` - ${c.reject_reason}`}
              </td>
              <td>{c.description ?? ''}</td>
              {/* text only: the admin page never loads or links the sender's image (AC-CONTRIB-07) */}
              <td className="admin-url">{c.image_url ?? ''}</td>
              <td>{c.nickname}</td>
              <td>{when(c.created_at)}</td>
              <td>
                {c.status === 'pending' && (
                  <>
                    <button type="button" onClick={() => start(c, 'edit')}>
                      Sửa
                    </button>
                    <button type="button" onClick={() => start(c, 'approve')}>
                      Duyệt
                    </button>
                    <button type="button" onClick={() => start(c, 'reject')}>
                      Từ chối
                    </button>
                  </>
                )}
                {form(c)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 && <p>Không có đề xuất.</p>}
      <Pager page={data} onPage={setPage} />
    </>
  )
}

const TIER_NAMES = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ'] as const
const tierName = (tier: number) => TIER_NAMES[tier - 1] ?? String(tier)

function ContentTab(ctx: Ctx) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [state, setState] = useState('')
  const [tier, setTierFilter] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState<ElementItem | null>(null)
  const [tierError, setTierError] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const params = new URLSearchParams({ page: String(page) })
  if (query) params.set('q', query)
  if (state) params.set('state', state)
  if (tier) params.set('tier', tier)
  const { data, error } = useList<ElementItem>(ctx, `elements?${params}`, reload)
  const recipes = useList<RecipeItem>(ctx, open ? `recipes?element_id=${open.id}` : null, reload)
  const mod = useModerate(ctx, () => setReload((n) => n + 1))

  const search = (e: FormEvent) => {
    e.preventDefault()
    setQuery(q.trim().slice(0, 100))
    setPage(1)
  }
  const changeTier = (id: string, value: string) => {
    setTierError(null)
    setTier(ctx.token, id, value === 'auto' ? 'auto' : Number(value)).then(
      () => setReload((n) => n + 1),
      (err: unknown) => (err instanceof AuthError ? ctx.onAuthError() : setTierError(errorText(err))),
    )
  }
  // AC-ART-13: checked and normalized here, so a refused file never reaches the server
  const uploadDrawing = (id: string, file: File | undefined) => {
    if (!file) return
    const refused = drawingProblem(file)
    setImageError(refused) // null on a valid pick also clears the error of an earlier upload
    if (refused) return
    toWebp256(file)
      .then((webp) => setImage(ctx.token, id, webp))
      .then(
        () => setReload((n) => n + 1),
        (err: unknown) =>
          err instanceof AuthError ? ctx.onAuthError() : setImageError(err instanceof DrawingError ? err.message : errorText(err)),
      )
  }
  const button = (label: string, kind: Kind, id: string, action: Action) => (
    <button type="button" onClick={() => mod.run(kind, id, action)}>
      {label}
    </button>
  )

  return (
    <>
      <form className="admin-filters" onSubmit={search}>
        <label>
          Tìm phần tử
          <input value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          Trạng thái
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Tất cả</option>
            <option value="active">Đang hiện</option>
            <option value="hidden">Đang ẩn</option>
            <option value="blocked">Đã chặn</option>
          </select>
        </label>
        <label>
          Tier
          <select
            value={tier}
            onChange={(e) => {
              setTierFilter(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Tất cả</option>
            {TIER_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {i + 1} {name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Tìm</button>
        {mod.reasonBox}
      </form>
      <Alert>{error ?? mod.error ?? tierError ?? imageError ?? recipes.error}</Alert>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Phần tử</th>
            <th>Độ sâu</th>
            <th>Trạng thái</th>
            <th>Ảnh</th>
            <th>Tier</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((e) => (
            <tr key={e.id}>
              <td>
                {e.emoji} {e.name}
              </td>
              <td>{e.depth}</td>
              <td>{STATE_LABEL[e.state]}</td>
              <td>
                {e.image_key && <img className="admin-thumb" src={withBase(`img/${e.image_key}`)} alt={`Ảnh của ${e.name}`} width={48} height={48} />}
                {STATE_LABEL[e.image_state]}
                {e.image_source === 'admin' && ' · admin tải'}
                {e.image_state === 'active' && button('Ẩn ảnh', 'image', e.id, 'hide')}
                {e.image_state === 'hidden' && button('Hiện ảnh', 'image', e.id, 'show')}
                <label className="admin-upload">
                  Tải tranh vẽ
                  <input
                    type="file"
                    accept={DRAWING_TYPES.join(',')}
                    aria-label={`Tải tranh vẽ cho ${e.name}`}
                    onChange={(ev) => {
                      uploadDrawing(e.id, ev.target.files?.[0])
                      ev.target.value = ''
                    }}
                  />
                </label>
              </td>
              <td>
                {tierName(e.tier)} · {e.tier_source === 'admin' ? 'Admin gán' : 'Tự động'}
                <br />
                Tự động: {e.auto_tier === null ? 'chưa có' : tierName(e.auto_tier)}
                <br />
                <select
                  aria-label={`Tier của ${e.name}`}
                  value={e.tier_source === 'admin' ? String(e.tier) : 'auto'}
                  onChange={(ev) => changeTier(e.id, ev.target.value)}
                >
                  <option value="auto">Tự động (theo độ sâu)</option>
                  {TIER_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {i + 1} {name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {e.state === 'active' && button('Ẩn', 'element', e.id, 'hide')}
                {e.state === 'hidden' && button('Hiện', 'element', e.id, 'show')}
                {e.state === 'blocked' ? button('Gỡ chặn', 'element', e.id, 'unblock') : button('Chặn vĩnh viễn', 'element', e.id, 'block')}
                <button type="button" onClick={() => setOpen(open?.id === e.id ? null : e)}>
                  Công thức
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={data} onPage={setPage} />
      {open && (
        <section aria-label={`Công thức của ${open.name}`}>
          <h2>
            Công thức có {open.emoji} {open.name}
          </h2>
          <ul className="admin-recipes">
            {recipes.data?.items.map((r) => (
              <li key={r.id}>
                {r.a.emoji} {r.a.name} + {r.b.emoji} {r.b.name} = {r.result.emoji} {r.result.name} ({STATE_LABEL[r.state]}){' '}
                {r.state === 'active' ? button('Ẩn công thức', 'recipe', r.id, 'hide') : button('Hiện công thức', 'recipe', r.id, 'show')}
              </li>
            ))}
          </ul>
          {recipes.data?.items.length === 0 && <p>Không có công thức.</p>}
        </section>
      )}
    </>
  )
}

/** Số khái niệm theo nguồn; nguồn lỗi hiện loại lỗi thay vì số (AC-ADMIN-11). Đợt cũ chưa có `sources` chỉ có lỗi nguồn. */
function sourcesText(stats: BatchStats): string {
  if (stats.sources) return stats.sources.map((s) => `${s.source} ${s.error ?? s.concepts ?? 0}`).join(' · ')
  return (stats.source_errors ?? []).map((e) => `${e.source} ${e.error}`).join(' · ')
}

/** Thêm, vào hàng chờ, bị chặn theo danh mục (chỉ số đếm), quota Gemini. */
function resultText(stats: BatchStats): string {
  const blocked = Object.entries(stats.blocked ?? {}).map(([k, n]) => `${k} ${n}`)
  return [`thêm ${stats.added ?? 0}`, `hàng chờ ${stats.queued ?? 0}`, ...blocked, `quota ${stats.quota_used ?? 0}`].join(' · ')
}

function LogsTab(ctx: Ctx) {
  const [batchPage, setBatchPage] = useState(1)
  const [auditPage, setAuditPage] = useState(1)
  const batches = useList<BatchItem, { summary?: BatchSummary }>(ctx, `batches?page=${batchPage}&size=20`, 0)
  const summary = batches.data?.summary
  const audit = useList<AuditItem>(ctx, `audit?page=${auditPage}&size=20`, 0)
  return (
    <>
      <h2>Các đợt</h2>
      <Alert>{batches.error}</Alert>
      {summary && (
        <ul className="admin-summary">
          <li>Tổng khái niệm đã crawl: {summary.crawled_total}</li>
          <li>Tổng phần tử đã thêm: {summary.added_total}</li>
          <li>Meme đang trong hàng chờ: {summary.queue_size ?? '-'}</li>
          <li>Phần tử chưa có ảnh: {summary.without_image ?? '-'}</li>
        </ul>
      )}
      <table className="admin-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>Giờ mẻ</th>
            <th>Chế độ</th>
            <th>Trạng thái</th>
            <th>Nguồn crawl</th>
            <th>Kết quả</th>
            <th>Ảnh</th>
            <th>Issue</th>
          </tr>
        </thead>
        <tbody>
          {batches.data?.items.map((b) => (
            <tr key={b.id}>
              <td>{b.version ?? '-'}</td>
              <td>{when(b.batch_at)}</td>
              <td>{b.mode}</td>
              <td>
                {b.status}
                {b.failed_step && ` (${b.failed_step})`}
                {b.rollback_to != null && ` → v${b.rollback_to}`}
              </td>
              {b.mode === 'core' ? <td>không crawl</td> : <td>{sourcesText(b.stats)}</td>}
              <td>{resultText(b.stats)}</td>
              <td>{b.stats.images ? `vẽ ${b.stats.images.drawn} · emoji ${b.stats.images.fallback} · chờ vẽ ${b.stats.images.pending}` : '-'}</td>
              <td>
                {b.issue_url?.startsWith('https://github.com/') ? (
                  <a href={b.issue_url} target="_blank" rel="noreferrer">
                    Báo cáo
                  </a>
                ) : (
                  '-'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {batches.data?.items.length === 0 && <p>Chưa có đợt nào</p>}
      <Pager page={batches.data} onPage={setBatchPage} />

      <h2>Audit</h2>
      <Alert>{audit.error}</Alert>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Thời điểm</th>
            <th>Thao tác</th>
            <th>Đích</th>
            <th>Trước → sau</th>
            <th>Lý do</th>
            <th>Token</th>
          </tr>
        </thead>
        <tbody>
          {audit.data?.items.map((a, i) => (
            <tr key={`${a.created_at}:${a.target_id}:${i}`}>
              <td>{when(a.created_at)}</td>
              <td>{a.action}</td>
              <td>
                {a.target_kind} <code>{a.target_id.slice(0, 10)}…</code>
              </td>
              <td>
                {a.before} → {a.after}
              </td>
              <td>{a.reason ?? ''}</td>
              <td>
                <code>{a.token_fp}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={audit.data} onPage={setAuditPage} />
    </>
  )
}
