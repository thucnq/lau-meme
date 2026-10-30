import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ApiError,
  AuthError,
  approveContribution,
  approveRejected,
  clearDailyPin,
  editElement,
  editRejected,
  getElement,
  getRejected,
  unblockRejected,
  getDailyPin,
  setDailyPin,
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
  type DailyPin,
  type ElementDetail,
  type ElementEdit,
  type ElementItem,
  type Kind,
  type Page,
  type RecipeItem,
  type ReportItem,
  type RejectedItem,
  type RejectedStatus,
  type RejectedText,
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

const TABS = ['Báo cáo', 'Nội dung', 'Bị chặn', 'Đề xuất meme', 'Món đặc biệt', 'Đợt + Audit'] as const
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
        {tab === 'Bị chặn' && <RejectedTab {...ctx} />}
        {tab === 'Đề xuất meme' && <ContributionsTab {...ctx} />}
        {tab === 'Món đặc biệt' && <DailyPinTab {...ctx} />}
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
const APPROVED = 'Đã duyệt. Meme lên danh mục và game ở mẻ kế tiếp'

/**
 * "Đề xuất meme" (AC-CONTRIB-07/08): oldest first, filtered by status. Edit sends only the changed fields; approve
 * needs the image hint the illustration is drawn from; reject needs a reason. The image link is plain text - the
 * page never loads it. An approved meme reaches the catalog only with the next batch (AC-CONTRIB-14, ADR 0013).
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
  const [useLink, setUseLink] = useState(false)
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const start = (c: ContributionItem, mode: Open['mode']) => {
    setOpen({ id: c.id, mode })
    setActionError(null)
    setNotice(null)
    setDraft({ name: c.name, emoji: c.emoji ?? '', description: c.description ?? '', image_url: c.image_url ?? '' })
    setHint('')
    setTierValue(1)
    setUseLink(false)
    setReason('')
  }
  const run = (task: Promise<unknown>, done: string | null = null) =>
    task.then(
      () => {
        setOpen(null)
        setNotice(done)
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
          onSubmit={(e: FormEvent) => (e.preventDefault(), void run(approveContribution(ctx.token, c.id, hint.trim(), tier, useLink && c.image_url !== null), APPROVED))}
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
          {c.image_url !== null && (
            <label>
              <input type="checkbox" checked={useLink} onChange={(e) => setUseLink(e.target.checked)} />
              Dùng link làm ảnh
            </label>
          )}
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
              setNotice(null)
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
      {notice && <p role="status">{notice}</p>}
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
                {c.status === 'approved' && !c.in_catalog && (
                  <>
                    {' - '}
                    <span>Chờ mẻ kế tiếp</span>
                  </>
                )}
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
  const [editing, setEditing] = useState<ElementItem | null>(null)
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
                <button type="button" aria-label={`Sửa ${e.name}`} onClick={() => setEditing(editing?.id === e.id ? null : e)}>
                  Sửa
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={data} onPage={setPage} />
      {editing && <ElementEditor key={editing.id} {...ctx} item={editing} onSaved={() => setReload((n) => n + 1)} />}
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

// ------------------------------------------------------------------------------------------------ AC-ADMIN-16

type TextField = 'name' | 'emoji' | 'description' | 'daily_hint' | 'image_hint'
const TEXT_FIELDS: { key: TextField; label: string; max: number; long?: boolean }[] = [
  { key: 'name', label: 'Tên', max: 100 },
  { key: 'emoji', label: 'Emoji', max: 16 },
  { key: 'description', label: 'Mô tả', max: 200, long: true },
  { key: 'daily_hint', label: 'Gợi ý Daily', max: 200, long: true },
  { key: 'image_hint', label: 'Gợi ý ảnh', max: 300, long: true },
]
type Texts = Record<TextField, string>

/** Only the fields that differ from `from`; an emptied field is sent as null. */
function changed<K extends string>(from: Record<K, string>, to: Record<K, string>): Partial<Record<K, string | null>> {
  const out: Partial<Record<K, string | null>> = {}
  for (const k of Object.keys(to) as K[]) if (to[k] !== from[k]) out[k] = to[k].trim() === '' ? null : to[k]
  return out
}

function TextInputs({ values, onChange, readOnly }: { values: Texts; onChange: (v: Texts) => void; readOnly?: boolean }) {
  return (
    <>
      {TEXT_FIELDS.map((f) =>
        readOnly ? (
          <p key={f.key}>
            {f.label}: {values[f.key] || 'chưa có'}
          </p>
        ) : (
          <label key={f.key}>
            {f.label}
            {f.long ? (
              <textarea value={values[f.key]} maxLength={f.max} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input value={values[f.key]} maxLength={f.max} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
            )}
          </label>
        ),
      )}
    </>
  )
}

/** "Sửa <tên>" in "Nội dung": every field of a live element; the graph has it from the next batch ("Chờ mẻ kế tiếp"). */
function ElementEditor({ token, onAuthError, item, onSaved }: Ctx & { item: ElementItem; onSaved: () => void }) {
  const [detail, setDetail] = useState<ElementDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getElement(token, item.id).then(
      (d) => live && setDetail(d),
      (err: unknown) => live && (err instanceof AuthError ? onAuthError() : setError(errorText(err))),
    )
    return () => {
      live = false
    }
  }, [token, item.id, onAuthError])
  return (
    <section aria-label={`Sửa ${item.name}`}>
      <h2>
        Sửa {item.emoji} {item.name}
      </h2>
      <Alert>{error}</Alert>
      {detail && (
        <ElementForm
          key={JSON.stringify(detail)}
          detail={detail}
          save={(body) =>
            editElement(token, item.id, body).then(
              (d) => {
                setError(null)
                setDetail(d)
                onSaved()
              },
              (err: unknown) => (err instanceof AuthError ? onAuthError() : setError(errorText(err))),
            )
          }
        />
      )}
    </section>
  )
}

function ElementForm({ detail, save }: { detail: ElementDetail; save: (body: ElementEdit) => void }) {
  const current = (k: TextField | 'origin') => String(detail.edit?.[k] ?? detail.published[k] ?? '')
  const initial = { ...(Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, current(f.key)])) as Texts), origin: current('origin') }
  const [values, setValues] = useState(initial)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const body = changed(initial, values) as ElementEdit
    if (Object.keys(body).length) save(body)
  }
  return (
    <form className="admin-edit" onSubmit={submit}>
      {detail.pending && <p className="admin-pending">Chờ mẻ kế tiếp</p>}
      <TextInputs values={values} onChange={(v) => setValues({ ...values, ...v })} />
      <label>
        Nguồn gốc
        <select value={values.origin} onChange={(e) => setValues({ ...values, origin: e.target.value })}>
          <option value="vn">VN</option>
          <option value="intl">Quốc tế</option>
        </select>
      </label>
      <button type="submit">Lưu</button>
    </form>
  )
}

// ------------------------------------------------------------------------------------------------ AC-ADMIN-13..15

const REJECTED_STATUS: Record<RejectedStatus, string> = {
  blocked: 'Bị chặn',
  unblocked: 'Đã bỏ chặn - chờ mẻ',
  added: 'Đã thêm',
  approved: 'Đã duyệt tay',
}
const STEP_LABEL = { layer1: 'Lớp 1', layer2: 'Lớp 2' } as const
/** Reason codes the pipeline sends (moderation.LABELS); a code seen in the list is added with its own label. */
const KNOWN_REASONS: [string, string][] = [
  ['banned_word', 'Từ cấm'],
  ['blocked_alias', 'Bí danh bị chặn'],
  ['admin_blocked', 'Đã bị quản trị chặn'],
  ['real_person', 'Người thật'],
  ['accusation', 'Cáo buộc người thật'],
  ['politics', 'Chính trị'],
  ['religion', 'Tôn giáo'],
  ['sexual', 'Tình dục'],
  ['discrimination', 'Phân biệt'],
  ['body_shaming', 'Body shaming'],
  ['violence', 'Bạo lực'],
  ['drugs', 'Ma túy'],
  ['self_harm', 'Tự hại'],
  ['harassment', 'Quấy rối'],
  ['unsure', 'Không chắc'],
  ['not_meme', 'Không phải meme'],
]

function RejectedTab(ctx: Ctx) {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [reason, setReason] = useState('')
  const [step, setStep] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState<RejectedItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const params = new URLSearchParams({ page: String(page) })
  if (query) params.set('q', query)
  if (reason) params.set('reason', reason)
  if (step) params.set('step', step)
  if (status) params.set('status', status)
  const { data, error: listError } = useList<RejectedItem>(ctx, `rejected?${params}`, reload)
  const reasons = new Map(KNOWN_REASONS)
  for (const r of data?.items ?? []) for (const x of r.reasons) if (!reasons.has(x.code)) reasons.set(x.code, x.label)
  const filter = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value)
    setPage(1)
  }
  const search = (e: FormEvent) => {
    e.preventDefault()
    setQuery(q.trim().slice(0, 100))
    setPage(1)
  }
  const show = (row: RejectedItem) => {
    setError(null)
    getRejected(ctx.token, row.id).then(setOpen, (err: unknown) => (err instanceof AuthError ? ctx.onAuthError() : setError(errorText(err))))
  }
  const done = (row: RejectedItem) => {
    setOpen(row)
    setReload((n) => n + 1)
  }

  return (
    <>
      <form className="admin-filters" onSubmit={search}>
        <label>
          Lý do
          <select value={reason} onChange={filter(setReason)}>
            <option value="">Tất cả</option>
            {[...reasons].map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bước
          <select value={step} onChange={filter(setStep)}>
            <option value="">Tất cả</option>
            <option value="layer1">Lớp 1</option>
            <option value="layer2">Lớp 2</option>
          </select>
        </label>
        <label>
          Trạng thái
          <select value={status} onChange={filter(setStatus)}>
            <option value="">Tất cả</option>
            {Object.entries(REJECTED_STATUS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <input aria-label="Tìm theo tên" placeholder="Tìm theo tên" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Tìm</button>
      </form>
      <Alert>{listError ?? error}</Alert>
      {data?.items.length === 0 ? (
        <p>Chưa có nội dung bị chặn</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Khái niệm</th>
              <th>Lý do</th>
              <th>Bước</th>
              <th>Nguồn</th>
              <th>Số lần gặp</th>
              <th>Lần gặp cuối</th>
              <th>Trạng thái</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.emoji} {r.name}
                </td>
                <td>{r.reasons.map((x) => x.label).join(', ')}</td>
                <td>{STEP_LABEL[r.step]}</td>
                <td>{r.source_name}</td>
                <td>{r.seen_count} lần</td>
                <td>{when(r.last_seen_at)}</td>
                <td>{REJECTED_STATUS[r.status]}</td>
                <td>
                  <button type="button" aria-label={`Xem ${r.name}`} onClick={() => show(r)}>
                    Xem
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={data} onPage={setPage} />
      {open && <RejectedDetail key={JSON.stringify(open)} {...ctx} row={open} onDone={done} />}
    </>
  )
}

const textsOf = (r: RejectedItem): Texts => Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, r[f.key] ?? ''])) as Texts

/** Detail, "Lưu", "Bỏ chặn" and "Duyệt luôn" of one row; added / approved rows are read-only (AC-ADMIN-14). */
function RejectedDetail({ token, onAuthError, row, onDone }: Ctx & { row: RejectedItem; onDone: (row: RejectedItem) => void }) {
  const initial = textsOf(row)
  const [values, setValues] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [a, setA] = useState<ElementItem | null>(null)
  const [b, setB] = useState<ElementItem | null>(null)
  const editable = row.status === 'blocked' || row.status === 'unblocked'
  const run = (command: Promise<RejectedItem>) =>
    command.then(onDone, (err: unknown) => (err instanceof AuthError ? onAuthError() : setError(errorText(err))))
  const save = (e: FormEvent) => {
    e.preventDefault()
    const body = changed(initial, values) as RejectedText
    if (Object.keys(body).length) run(editRejected(token, row.id, body))
  }
  const canApprove = a !== null && b !== null && a.id !== b.id && values.name.trim() !== '' && values.emoji.trim() !== ''
  const approve = () => {
    if (!a || !b) return
    const optional = Object.fromEntries((['description', 'daily_hint', 'image_hint'] as const).filter((k) => values[k].trim()).map((k) => [k, values[k]]))
    run(approveRejected(token, row.id, { a: a.id, b: b.id, name: values.name.trim(), emoji: values.emoji.trim(), ...optional }))
  }
  return (
    <section aria-label={`Chi tiết ${row.name}`} className="admin-edit">
      <h2>
        {row.emoji} {row.name} · {REJECTED_STATUS[row.status]}
      </h2>
      <p>Lý do: {row.reasons.map((x) => x.label).join(', ')}</p>
      <p>
        Nguồn: {row.source_name}
        {row.source_url && (
          <>
            {' · '}
            <a href={row.source_url} target="_blank" rel="noopener noreferrer">
              {row.source_url}
            </a>
          </>
        )}
      </p>
      <p>Ngữ cảnh: {row.context ?? 'không có'}</p>
      <Alert>{error}</Alert>
      {editable ? (
        <form onSubmit={save}>
          <TextInputs values={values} onChange={setValues} />
          <button type="submit">Lưu</button>
          {row.status === 'blocked' && (
            <button type="button" onClick={() => run(unblockRejected(token, row.id))}>
              Bỏ chặn
            </button>
          )}
          <ElementPicker side="A" token={token} onAuthError={onAuthError} picked={a} onPick={setA} />
          <ElementPicker side="B" token={token} onAuthError={onAuthError} picked={b} onPick={setB} />
          <button type="button" disabled={!canApprove} onClick={approve}>
            Duyệt luôn
          </button>
        </form>
      ) : (
        <TextInputs values={values} onChange={setValues} readOnly />
      )}
    </section>
  )
}

/** "Tìm phần tử A/B" for "Duyệt luôn": the pair A + B that makes the concept (AC-ADMIN-15). */
function ElementPicker({ side, token, onAuthError, picked, onPick }: Ctx & { side: 'A' | 'B'; picked: ElementItem | null; onPick: (e: ElementItem) => void }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<ElementItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const find = () => {
    setError(null)
    call<Page<ElementItem>>(token, `elements?${new URLSearchParams({ q: q.trim().slice(0, 100), state: 'active' })}`).then(
      (p) => setFound(p.items),
      (err: unknown) => (err instanceof AuthError ? onAuthError() : setError(errorText(err))),
    )
  }
  return (
    <fieldset>
      <legend>
        Phần tử {side}: {picked ? `${picked.emoji} ${picked.name}` : 'chưa chọn'}
      </legend>
      <input aria-label={`Tìm phần tử ${side}`} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
      <button type="button" onClick={find}>
        Tìm {side}
      </button>
      <Alert>{error}</Alert>
      {found.map((e) => (
        <button key={e.id} type="button" aria-label={`Chọn ${side} ${e.name}`} onClick={() => onPick(e)}>
          {e.emoji} {e.name}
        </button>
      ))}
    </fieldset>
  )
}

/** Số khái niệm theo nguồn; nguồn lỗi hiện loại lỗi thay vì số (AC-ADMIN-11). Đợt cũ chưa có `sources` chỉ có lỗi nguồn. */
function sourcesText(stats: BatchStats): string {
  if (stats.sources) return stats.sources.map((s) => `${s.source} ${s.error ?? s.concepts ?? 0}`).join(' · ')
  return (stats.source_errors ?? []).map((e) => `${e.source} ${e.error}`).join(' · ')
}

/**
 * AC-DAILY-19, ADR 0019: Món đặc biệt của mẻ kế tiếp. Any element that is not hidden or blocked (the server checks
 * that and the hint); the pin is used by one batch and then cleared.
 */
function DailyPinTab({ token, onAuthError }: Ctx) {
  const [pin, setPin] = useState<DailyPin | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ElementItem[]>([])
  const [chosen, setChosen] = useState<ElementItem | null>(null)
  const [hint, setHint] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0) // only the newest search may fill the list

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof AuthError) onAuthError()
      else setError(errorText(err))
    },
    [onAuthError],
  )
  useEffect(() => {
    let live = true
    getDailyPin(token).then(
      (d) => live && setPin(d.pin),
      (err: unknown) => live && fail(err),
    )
    return () => {
      live = false
    }
  }, [token, fail])

  const search = (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    const seq = ++latest.current
    call<Page<ElementItem>>(token, `elements?q=${encodeURIComponent(q)}&size=20`).then(
      (d) => seq === latest.current && setResults(d.items),
      fail,
    )
  }
  const submit = () => {
    if (!chosen || !hint.trim()) return
    setBusy(true)
    setError(null)
    setDailyPin(token, chosen.id, hint.trim())
      .then((r) => {
        setPin(r.after)
        setChosen(null)
        setHint('')
      }, fail)
      .finally(() => setBusy(false))
  }
  const clear = () => {
    setBusy(true)
    setError(null)
    clearDailyPin(token)
      .then(() => setPin(null), fail)
      .finally(() => setBusy(false))
  }

  return (
    <>
      <h2>Món đặc biệt mẻ kế tiếp</h2>
      <Alert>{error}</Alert>
      {pin === null && <p>Chưa có chỉ định</p>}
      {pin && (
        <div className="admin-pin">
          <p>
            {pin.emoji} <strong>{pin.name}</strong> - chỉ định lúc {when(pin.created_at)}
          </p>
          <p>{pin.hint}</p>
          <button type="button" disabled={busy} onClick={clear}>
            Bỏ chỉ định
          </button>
        </div>
      )}
      <h2>Chỉ định món</h2>
      <p>Món nào cũng được, miễn không bị ẩn hay chặn. Chỉ áp cho một mẻ kế tiếp, các mẻ sau tự chọn lại.</p>
      <form onSubmit={search}>
        <input aria-label="Tìm phần tử" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tên phần tử" />
        <button type="submit">Tìm</button>
      </form>
      <ul>
        {results.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              aria-label={`Chọn ${r.name}`}
              aria-pressed={chosen?.id === r.id}
              disabled={r.state !== 'active'}
              onClick={() => setChosen(r)}
            >
              {r.emoji} {r.name}
            </button>{' '}
            depth {r.depth}
            {r.state !== 'active' && ` (${r.state})`}
          </li>
        ))}
      </ul>
      {chosen && (
        <p>
          Đã chọn: {chosen.emoji} {chosen.name}
        </p>
      )}
      <label>
        Gợi ý
        <textarea aria-label="Gợi ý" maxLength={200} value={hint} onChange={(e) => setHint(e.target.value)} />
      </label>
      <button type="button" disabled={busy || !chosen || !hint.trim()} onClick={submit}>
        Chỉ định cho mẻ kế tiếp
      </button>
    </>
  )
}

/** Thêm, vào hàng chờ, bị chặn theo danh mục (chỉ số đếm), quota Gemini. */
function resultText(stats: BatchStats): string {
  const blocked = Object.entries(stats.blocked ?? {}).map(([k, n]) => `${k} ${n}`)
  const pin = stats.daily_pin ? [stats.daily_pin === 'used' ? 'dùng món chỉ định' : 'bỏ món chỉ định'] : []
  return [`thêm ${stats.added ?? 0}`, `hàng chờ ${stats.queued ?? 0}`, ...blocked, `quota ${stats.quota_used ?? 0}`, ...pin].join(' · ')
}

const auditText = (v: AuditItem['before']) => (typeof v === 'string' ? v : JSON.stringify(v))

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
                {auditText(a.before)} → {auditText(a.after)}
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
