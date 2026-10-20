/**
 * Game screen (docs/acceptance/game.md): the plate ("Đĩa nhúng"), the table and the hot pot with two drop slots.
 * Drag and drop uses Pointer Events; the drop target is found with document.elementFromPoint.
 * Progress lives only in localStorage — this screen never sends a write request.
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getBlocklist, getGraph, getManifest } from '../api'
import type { Graph } from '../graph/crypto'
import {
  EMPTY_BLOCKLIST,
  THEME_KEY,
  combine,
  filterItems,
  initialProgress,
  isNew,
  loadProgress,
  migrateProgress,
  resetProgress,
  resolveTheme,
  saveProgress,
  sortItems,
  visibleItems,
  visibleTable,
} from './engine'
import type { Blocklist, Item, Manifest, Progress, SortMode, TableItem } from './engine'

const BOIL_MS = 1000 // AC-GAME-02: ≤ 1,2 s
const STEAM_MS = 500 // AC-GAME-03: ≤ 0,6 s

type Loaded = { manifest: Manifest; graph: Graph; blocklist: Blocklist }
type Source = { item: Item; uid: string | null }
type Drag = { source: Source; x: number; y: number }
type Miss = { line: string; hint: string | null }

const storage = (): Storage => window.localStorage

function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readTheme(): 'light' | 'dark' {
  let stored: string | null = null
  try {
    stored = storage().getItem(THEME_KEY)
  } catch {
    // storage blocked: follow the system
  }
  return resolveTheme(stored, systemDark())
}

const newUid = (): string => crypto.randomUUID()

/** Where the n-th item lands when it comes out of the pot. */
function slotPosition(n: number): { x: number; y: number } {
  return { x: 24 + (n % 5) * 96, y: 24 + (Math.floor(n / 5) % 5) * 72 }
}

function onTable(item: Item, x: number, y: number): TableItem {
  return { uid: newUid(), id: item.id, name: item.name, emoji: item.emoji, x: Math.round(x), y: Math.round(y) }
}

export function Game() {
  const [progress, setProgress] = useState<Progress | null>(() => loadProgress(storage()))
  const progressRef = useRef(progress)
  const [tutorialOpen, setTutorialOpen] = useState(() => !progress?.tutorial_seen)
  const tutorialSeenRef = useRef(progress?.tutorial_seen ?? false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [slots, setSlots] = useState<[Item | null, Item | null]>([null, null])
  const [boiling, setBoiling] = useState(false)
  const boilingRef = useRef(false)
  const [miss, setMiss] = useState<Miss | null>(null)
  const [steam, setSteam] = useState<{ x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [theme, setTheme] = useState(readTheme)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Source | null>(null)
  const timers = useRef<number[]>([])

  const commit = (next: Progress) => {
    progressRef.current = next
    setProgress(next)
    saveProgress(storage(), next)
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((t) => window.clearTimeout(t))
  }, [])

  // Manifest + graph (+ blocklist, best effort). Progress is never touched when loading fails (AC-GAME-16).
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      const blocklist = getBlocklist(ctrl.signal).catch(() => EMPTY_BLOCKLIST)
      const manifest = await getManifest(ctrl.signal)
      const graph = await getGraph(manifest.graph_url, ctrl.signal)
      return { manifest, graph, blocklist: await blocklist }
    })().then(
      (next) => {
        const current = progressRef.current
        if (!current) {
          commit({ ...initialProgress(next.manifest, new Date()), tutorial_seen: tutorialSeenRef.current })
        } else if (current.graph_version !== next.manifest.version) {
          commit(migrateProgress(current, next.manifest))
        }
        setLoaded(next)
      },
      () => {
        if (!ctrl.signal.aborted) setLoadError(true)
      },
    )
    return () => ctrl.abort()
  }, [reloadKey])

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  const blocklist = loaded?.blocklist ?? EMPTY_BLOCKLIST
  const ready = loaded !== null && progress !== null
  const ctx = loaded ? { ...loaded, now: () => new Date() } : null

  // ---------------------------------------------------------------- combining
  const boil = (a: Item, b: Item) => {
    const p = progressRef.current
    if (!ctx || !p) return
    boilingRef.current = true
    setBoiling(true)
    setMiss(null)
    const outcome = combine(ctx, p, a.name, b.name)
    later(() => {
      void outcome.then((out) => {
        const table = progressRef.current?.table ?? p.table
        if (out.kind === 'hit') {
          const item = out.progress.items.find((i) => i.id === out.result.id)!
          const at = slotPosition(table.length)
          commit({ ...out.progress, table: [...table, onTable(item, at.x, at.y)] })
        } else {
          const [pa, pb] = [slotPosition(table.length), slotPosition(table.length + 1)]
          commit({ ...out.progress, table: [...table, onTable(a, pa.x, pa.y), onTable(b, pb.x, pb.y)] })
          setMiss({ line: out.line, hint: out.hint })
        }
        setSlots([null, null])
        boilingRef.current = false
        setBoiling(false)
      })
    }, BOIL_MS)
  }

  const stack = async (source: Source, target: TableItem, x: number, y: number) => {
    const p = progressRef.current
    if (!ctx || !p) return
    setMiss(null)
    const out = await combine(ctx, p, source.item.name, target.name)
    const table = (progressRef.current ?? p).table.filter((t) => t.uid !== source.uid)
    if (out.kind === 'hit') {
      const item = out.progress.items.find((i) => i.id === out.result.id)!
      const rest = table.filter((t) => t.uid !== target.uid)
      commit({ ...out.progress, table: [...rest, onTable(item, target.x, target.y)] })
      setSteam({ x: target.x, y: target.y })
      later(() => setSteam(null), STEAM_MS)
    } else {
      commit({ ...out.progress, table: [...table, onTable(source.item, x, y)] })
      setMiss({ line: out.line, hint: out.hint })
    }
  }

  // ---------------------------------------------------------------- drag and drop
  const drop = (source: Source, el: Element | null, clientX: number, clientY: number) => {
    const p = progressRef.current
    if (!el || !p || boilingRef.current) return
    const slotEl = el.closest('[data-slot]')
    if (slotEl) {
      if (!ready) return
      const n = Number(slotEl.getAttribute('data-slot')) === 2 ? 1 : 0
      const next: [Item | null, Item | null] = [...slots]
      next[n] = source.item
      if (source.uid) commit({ ...p, table: p.table.filter((t) => t.uid !== source.uid) })
      setSlots(next)
      if (next[0] && next[1]) boil(next[0], next[1])
      return
    }
    const tableEl = el.closest('[data-testid="table"]')
    if (!tableEl) {
      // Dragged off the table: take it off.
      if (source.uid) commit({ ...p, table: p.table.filter((t) => t.uid !== source.uid) })
      return
    }
    const rect = tableEl.getBoundingClientRect()
    const [x, y] = [clientX - rect.left, clientY - rect.top]
    const targetUid = el.closest('[data-uid]')?.getAttribute('data-uid')
    const target = p.table.find((t) => t.uid === targetUid && t.uid !== source.uid)
    if (target && ready) {
      void stack(source, target, x, y)
      return
    }
    const rest = p.table.filter((t) => t.uid !== source.uid)
    commit({ ...p, table: [...rest, onTable(source.item, x, y)] })
  }

  const dragHandlers = (source: Source) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (boilingRef.current || e.button !== 0) return
      e.preventDefault()
      if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = source
      setDrag({ source, x: e.clientX, y: e.clientY })
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (dragRef.current) setDrag({ source: dragRef.current, x: e.clientX, y: e.clientY })
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const src = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (src) drop(src, document.elementFromPoint(e.clientX, e.clientY), e.clientX, e.clientY)
    },
    onPointerCancel: () => {
      dragRef.current = null
      setDrag(null)
    },
  })

  // ---------------------------------------------------------------- toolbar
  const closeTutorial = () => {
    setTutorialOpen(false)
    tutorialSeenRef.current = true
    const p = progressRef.current
    if (p && !p.tutorial_seen) commit({ ...p, tutorial_seen: true })
  }

  const clearTable = () => {
    const p = progressRef.current
    if (p) commit({ ...p, table: [] })
  }

  const restart = () => {
    setConfirmReset(false)
    resetProgress(storage())
    setSlots([null, null])
    setMiss(null)
    if (loaded) commit({ ...initialProgress(loaded.manifest, new Date()), tutorial_seen: true })
    else {
      progressRef.current = null
      setProgress(null)
    }
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    try {
      storage().setItem(THEME_KEY, next)
    } catch {
      // storage blocked: the choice lasts for this session only
    }
    setTheme(next)
  }

  const setSort = (sort: SortMode) => {
    const p = progressRef.current
    if (p) commit({ ...p, sort })
  }

  const retry = () => {
    setLoadError(false)
    setReloadKey((k) => k + 1)
  }

  // ---------------------------------------------------------------- render
  const version = loaded?.manifest.version ?? progress?.graph_version ?? 0
  const items = progress ? visibleItems(progress, blocklist) : []
  const byId = new Map(items.map((i) => [i.id, i]))
  const plate = sortItems(filterItems(items, query), progress?.sort ?? 'newest')
  const table = progress ? visibleTable(progress, blocklist) : []
  const potState = !ready ? 'disabled' : boiling ? 'boiling' : 'idle'
  const badge = (item: Item | undefined) => (item && isNew(item, version, blocklist) ? <span className="badge">MỚI</span> : null)

  return (
    <div className="game">
      <header className="game-bar">
        <h1>Lẩu Meme</h1>
        <div className="game-actions">
          <button type="button" onClick={clearTable}>
            Dọn bàn
          </button>
          <button type="button" onClick={() => setConfirmReset(true)}>
            Chơi lại từ đầu
          </button>
          <button type="button" onClick={() => setTutorialOpen(true)} title="Hướng dẫn">
            ?
          </button>
          <button type="button" onClick={toggleTheme} aria-label="Chuyển chế độ sáng/tối">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {loadError && (
        <div role="alert" className="game-error">
          Không tải được nồi lẩu. Tiến độ của bạn vẫn còn nguyên.{' '}
          <button type="button" onClick={retry}>
            Thử lại
          </button>
        </div>
      )}

      <div className="game-board">
        <section className="game-table" data-testid="table" aria-label="Mặt bàn">
          {table.map((t) => (
            <div
              key={t.uid}
              className="chip on-table"
              data-testid="table-item"
              data-uid={t.uid}
              data-name={t.name}
              data-x={t.x}
              data-y={t.y}
              style={{ left: t.x, top: t.y }}
              {...dragHandlers({
                item: byId.get(t.id) ?? { ...t, depth: 0, added_version: 0, image_key: null, discovered_at: '' },
                uid: t.uid,
              })}
            >
              <span aria-hidden="true">{t.emoji}</span> {t.name}
              {badge(byId.get(t.id))}
            </div>
          ))}
          {steam && (
            <div className="steam" data-testid="stack-steam" style={{ left: steam.x, top: steam.y }} aria-hidden="true">
              ♨️
            </div>
          )}
          <div className="pot" data-testid="pot" data-state={potState} aria-label="Nồi lẩu">
            {([1, 2] as const).map((n) => {
              const it = slots[n - 1]
              return (
                <div key={n} className="pot-slot" data-testid={`pot-slot-${n}`} data-slot={n}>
                  {it ? `${it.emoji} ${it.name}` : ''}
                </div>
              )
            })}
          </div>
          {miss && (
            <div className="miss" aria-live="polite">
              <p data-testid="miss-line">{miss.line}</p>
              {miss.hint && <p data-testid="miss-hint">{miss.hint}</p>}
            </div>
          )}
        </section>

        <aside className="plate">
          <input
            type="search"
            aria-label="Tìm trong Đĩa nhúng"
            placeholder="Tìm món…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Sắp xếp"
            value={progress?.sort ?? 'newest'}
            onChange={(e) => setSort(e.target.value as SortMode)}
          >
            <option value="newest">Mới khám phá</option>
            <option value="name">Tên</option>
            <option value="depth">Độ sâu</option>
          </select>
          <ul aria-label="Đĩa nhúng">
            {plate.map((it) => (
              <li key={it.id} className="chip" data-testid="plate-item" data-name={it.name} {...dragHandlers({ item: it, uid: null })}>
                <span aria-hidden="true">{it.emoji}</span> {it.name}
                {badge(it)}
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {drag && (
        <div className="chip ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          {drag.source.item.emoji} {drag.source.item.name}
        </div>
      )}

      {tutorialOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="tutorial-title" className="modal">
          <h2 id="tutorial-title">Hướng dẫn</h2>
          <p>Kéo 2 món từ Đĩa nhúng thả vào nồi lẩu để nhúng ra món mới.</p>
          <p>Kéo một món thả chồng lên món khác trên bàn cũng nhúng được.</p>
          <button type="button" onClick={closeTutorial}>
            Đóng
          </button>
        </div>
      )}

      {confirmReset && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="reset-title" className="modal">
          <h2 id="reset-title">Chơi lại từ đầu?</h2>
          <p>Đĩa nhúng sẽ về 4 món khởi đầu. Nickname và chuỗi Daily vẫn được giữ.</p>
          <button type="button" onClick={() => setConfirmReset(false)}>
            Hủy
          </button>
          <button type="button" onClick={restart}>
            Xóa
          </button>
        </div>
      )}
    </div>
  )
}
