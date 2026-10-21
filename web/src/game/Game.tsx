/**
 * Game screen (docs/acceptance/game.md): the plate ("Đĩa nhúng"), the table and the hot pot with two drop slots.
 * Drag and drop uses Pointer Events; the drop target is found with document.elementFromPoint.
 * Progress lives only in localStorage - this screen never sends a write request.
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getGraph, getManifest } from '../api'
import { startManifestWatch } from '../daily/countdown'
import { DailyPanel } from '../daily/DailyPanel'
import { loadSolved, saveSolved, type SolvedDaily } from '../daily/solved'
import { BLOCKLIST_POLL_MS, loadBlocklist } from '../report/blocklist'
import type { Graph } from '../graph/crypto'
import { localStore as storage, migrateLegacyKeys } from '../storage'
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

function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readTheme(): 'light' | 'dark' {
  let stored: string | null = null
  try {
    stored = storage()?.getItem(THEME_KEY) ?? null
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

const CHIP_HALF = { x: 40, y: 16 } // drop point is the chip centre, like the drag ghost

function onTable(item: Item, x: number, y: number): TableItem {
  return { uid: newUid(), id: item.id, name: item.name, emoji: item.emoji, x: Math.round(x), y: Math.round(y) }
}

/** A combine that gave the player an element they did not have (AC-DISC-05): names as typed, id of the result. */
export type NewDiscovery = { a: string; b: string; result: string; id: string }

type Props = {
  onDiscover?: (d: NewDiscovery) => void
  /** Ids on the plate, so the page can look up who first found them (AC-DISC-09). */
  onItems?: (ids: string[]) => void
  /** Element id → "Công thức gia truyền của …" line. */
  heirlooms?: Record<string, string>
  /** Shows a "Báo cáo" button on each plate item (AC-REPORT-01). */
  onReport?: (item: { id: string; name: string; image_key: string | null }) => void
  /** Bumped by the page after a report: reload the block list at once, bypassing caches (AC-REPORT-04/05). */
  blocklistRefresh?: number
}

export function Game({ onDiscover, onItems, heirlooms = {}, onReport, blocklistRefresh = 0 }: Props = {}) {
  const onDiscoverRef = useRef(onDiscover)
  useEffect(() => {
    onDiscoverRef.current = onDiscover
  }, [onDiscover])
  const [progress, setProgress] = useState<Progress | null>(() => {
    const s = storage()
    if (!s) return null
    migrateLegacyKeys(s) // before the first read of progress or theme
    return loadProgress(s)
  })
  const progressRef = useRef(progress)
  const [tutorialOpen, setTutorialOpen] = useState(() => !progress?.tutorial_seen)
  const tutorialSeenRef = useRef(progress?.tutorial_seen ?? false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [slots, setSlots] = useState<[Item | null, Item | null]>([null, null])
  const potRef = useRef<HTMLDivElement>(null)
  const [boiling, setBoiling] = useState(false)
  const boilingRef = useRef(false)
  const [miss, setMiss] = useState<Miss | null>(null)
  const [steam, setSteam] = useState<{ x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [theme, setTheme] = useState(readTheme)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Source | null>(null)
  const busyRef = useRef(false) // a table stack is being looked up
  const generation = useRef(0) // bumped by "Chơi lại từ đầu": results of older combines are dropped
  const timers = useRef<number[]>([])

  const commit = (next: Progress) => {
    progressRef.current = next
    setProgress(next)
    const s = storage()
    if (s) saveProgress(s, next)
  }

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  // Manifest + graph (+ blocklist, best effort). Progress is never touched when loading fails (AC-GAME-16).
  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      const blocklist = loadBlocklist(ctrl.signal, storage()) // last good copy when offline (AC-REPORT-07)
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

  // Block list while playing: every minute, and at once after a report (AC-REPORT-05/07).
  const hasLoaded = loaded !== null
  useEffect(() => {
    if (!hasLoaded) return
    const ctrl = new AbortController()
    const refresh = (fresh: boolean) =>
      loadBlocklist(ctrl.signal, storage(), fresh).then((blocklist) => {
        if (!ctrl.signal.aborted) setLoaded((prev) => (prev ? { ...prev, blocklist } : prev))
      })
    if (blocklistRefresh > 0) void refresh(true)
    const timer = window.setInterval(() => void refresh(false), BLOCKLIST_POLL_MS)
    return () => {
      ctrl.abort()
      window.clearInterval(timer)
    }
  }, [hasLoaded, blocklistRefresh])

  // A new batch (or a new block list) without a reload of the page: once the next batch is due, re-read the
  // manifest every 60 s and load everything again when it changed (AC-DAILY-12, AC-REPORT-07).
  const batchAt = loaded?.manifest.batch_at
  useEffect(() => {
    if (!batchAt) return
    return startManifestWatch({ batchAt, fetchManifest: () => getManifest(), onChange: () => setReloadKey((k) => k + 1) })
  }, [batchAt])

  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id)
      fn()
    }, ms)
    timers.current.push(id)
  }

  const blocklist = loaded?.blocklist ?? EMPTY_BLOCKLIST
  const ready = loaded !== null && progress !== null
  const ctx = loaded ? { ...loaded, now: () => new Date() } : null

  // Món đặc biệt (AC-DAILY-04/05): making the batch's target on the pot or the table counts, even when it was
  // already on the plate; the pair is kept per batch so a reload still shows it solved.
  const dailyVersion = loaded?.manifest.version
  const [solved, setSolved] = useState<{ version: number | undefined; value: SolvedDaily | null }>({
    version: undefined,
    value: null,
  })
  if (solved.version !== dailyVersion) {
    setSolved({ version: dailyVersion, value: dailyVersion === undefined ? null : loadSolved(storage(), dailyVersion) })
  }
  const checkDaily = (a: string, b: string, result: Item) => {
    const m = loaded?.manifest
    if (!m || result.id !== m.daily.element_id || solved.value) return
    const value = { a, b, name: result.name }
    saveSolved(storage(), m.version, value)
    setSolved({ version: m.version, value })
  }

  // ---------------------------------------------------------------- combining
  const boil = (a: Item, b: Item) => {
    const p = progressRef.current
    if (!ctx || !p) return
    const gen = generation.current
    boilingRef.current = true
    setBoiling(true)
    setMiss(null)
    const outcome = combine(ctx, p, a.name, b.name)
    const [pa, pb] = [slotPosition(p.table.length), slotPosition(p.table.length + 1)]
    later(() => {
      outcome
        .then((out) => {
          if (gen !== generation.current) return
          const table = progressRef.current?.table ?? p.table
          if (out.kind === 'hit') {
            const item = out.progress.items.find((i) => i.id === out.result.id)!
            commit({ ...out.progress, table: [...table, onTable(item, pa.x, pa.y)] })
            checkDaily(a.name, b.name, item)
            if (out.isNew) onDiscoverRef.current?.({ a: a.name, b: b.name, result: item.name, id: item.id })
          } else {
            commit({ ...out.progress, table: [...table, onTable(a, pa.x, pa.y), onTable(b, pb.x, pb.y)] })
            setMiss({ line: out.line, hint: out.hint })
          }
        })
        .catch(() => {
          if (gen === generation.current) setMiss({ line: 'Nồi trục trặc, nhúng lại nhé.', hint: null })
        })
        .finally(() => {
          if (gen !== generation.current) return
          setSlots([null, null])
          boilingRef.current = false
          setBoiling(false)
        })
    }, BOIL_MS)
  }

  const stack = async (source: Source, target: TableItem, x: number, y: number) => {
    const p = progressRef.current
    if (!ctx || !p) return
    const gen = generation.current
    busyRef.current = true
    setMiss(null)
    try {
      const out = await combine(ctx, p, source.item.name, target.name)
      if (gen !== generation.current) return
      const table = (progressRef.current ?? p).table.filter((t) => t.uid !== source.uid)
      if (out.kind === 'hit') {
        const item = out.progress.items.find((i) => i.id === out.result.id)!
        const rest = table.filter((t) => t.uid !== target.uid)
        commit({ ...out.progress, table: [...rest, onTable(item, target.x, target.y)] })
        checkDaily(source.item.name, target.name, item)
        if (out.isNew)
          onDiscoverRef.current?.({ a: source.item.name, b: target.name, result: item.name, id: item.id })
        setSteam({ x: target.x, y: target.y })
        later(() => setSteam(null), STEAM_MS)
      } else {
        commit({ ...out.progress, table: [...table, onTable(source.item, x, y)] })
        setMiss({ line: out.line, hint: out.hint })
      }
    } catch {
      if (gen === generation.current) setMiss({ line: 'Nồi trục trặc, nhúng lại nhé.', hint: null })
    } finally {
      if (gen === generation.current) busyRef.current = false
    }
  }

  // ---------------------------------------------------------------- drag and drop
  const drop = (source: Source, el: Element | null, clientX: number, clientY: number) => {
    const p = progressRef.current
    if (!el || !p || boilingRef.current || busyRef.current) return
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
    const [x, y] = [Math.max(0, clientX - rect.left - CHIP_HALF.x), Math.max(0, clientY - rect.top - CHIP_HALF.y)]
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
      if (boilingRef.current || busyRef.current || e.button !== 0) return
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

  /** Keyboard path (Enter/Space on a plate item): put it in the next free pot slot. */
  const toPot = (item: Item) => {
    if (!ready || boilingRef.current || busyRef.current) return
    const next: [Item | null, Item | null] = slots[0] ? [slots[0], item] : [item, slots[1]]
    setSlots(next)
    if (next[0] && next[1]) boil(next[0], next[1])
  }

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
    generation.current += 1
    clearTimers()
    try {
      const s = storage()
      if (s) resetProgress(s)
    } catch {
      // storage blocked: in-memory progress is reset below
    }
    setSlots([null, null])
    boilingRef.current = false
    busyRef.current = false
    setBoiling(false)
    setSteam(null)
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
      storage()?.setItem(THEME_KEY, next)
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
  const itemIds = items.map((i) => i.id).join(',')
  useEffect(() => {
    if (itemIds) onItems?.(itemIds.split(','))
  }, [itemIds, onItems])
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

      {loaded && progress && (
        <DailyPanel
          key={loaded.manifest.version}
          manifest={loaded.manifest}
          solved={solved.value}
          storage={storage()}
        />
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
          {/* Drawn as a two-broth hot pot (lẩu uyên ương): one slot per broth, steam above, burner below. */}
          <div ref={potRef} className="pot" data-testid="pot" data-state={potState} aria-label="Nồi lẩu">
            <span className="pot-steam" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div className="pot-rim">
              {([1, 2] as const).map((n) => {
                const it = slots[n - 1]
                return (
                  <div key={n} className="pot-slot" data-testid={`pot-slot-${n}`} data-slot={n}>
                    {it ? `${it.emoji} ${it.name}` : ''}
                  </div>
                )
              })}
            </div>
            <span className="pot-body" aria-hidden="true" />
            <span className="pot-burner" aria-hidden="true" />
          </div>
          <div className="miss" aria-live="polite">
            {miss && <p data-testid="miss-line">{miss.line}</p>}
            {miss?.hint && <p data-testid="miss-hint">{miss.hint}</p>}
          </div>
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
              <li
                key={it.id}
                className="chip"
                data-testid="plate-item"
                data-name={it.name}
                title={heirlooms[it.id]}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toPot(it)
                  }
                }}
                {...dragHandlers({ item: it, uid: null })}
              >
                <span aria-hidden="true">{it.emoji}</span> {it.name}
                {badge(it)}
                {onReport && (
                  <button
                    type="button"
                    className="report-button"
                    aria-label={`Báo cáo ${it.name}`}
                    title="Báo cáo"
                    // the plate item drags on pointer down: keep the button out of it
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onClick={() => onReport({ id: it.id, name: it.name, image_key: it.image_key })}
                  >
                    ⚑
                  </button>
                )}
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
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tutorial-title"
          className="modal"
          onKeyDown={(e) => e.key === 'Escape' && closeTutorial()}
        >
          <h2 id="tutorial-title">Hướng dẫn</h2>
          <p>Kéo 2 món từ Đĩa nhúng thả vào nồi lẩu để nhúng ra món mới.</p>
          <p>Kéo một món thả chồng lên món khác trên bàn cũng nhúng được.</p>
          <button type="button" onClick={closeTutorial} autoFocus>
            Đóng
          </button>
        </div>
      )}

      {confirmReset && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reset-title"
          className="modal"
          onKeyDown={(e) => e.key === 'Escape' && setConfirmReset(false)}
        >
          <h2 id="reset-title">Chơi lại từ đầu?</h2>
          <p>Đĩa nhúng sẽ về 4 món khởi đầu. Nickname và chuỗi Daily vẫn được giữ.</p>
          <button type="button" onClick={() => setConfirmReset(false)} autoFocus>
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
