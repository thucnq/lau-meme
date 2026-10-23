/**
 * Game screen (docs/acceptance/game.md): the plate ("Đĩa nhúng"), the table and the hot pot with two drop slots.
 * Drag and drop uses Pointer Events; the drop target is found with document.elementFromPoint.
 * Progress lives only in localStorage - this screen never sends a write request.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getGraph, getManifest } from '../api'
import { DiscoveryZoom } from '../art/DiscoveryZoom'
import { AuthBar } from '../auth/AuthBar'
import { ElementIcon } from '../art/ElementIcon'
import { startManifestWatch } from '../daily/countdown'
import { DailyPanel, Leaderboards } from '../daily/DailyPanel'
import { loadSolved, saveSolved, type SolvedDaily } from '../daily/solved'
import { recordCombine, trackEvent } from '../metrics/app'
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
  tierOf,
  visibleItems,
  visibleTable,
} from './engine'
import type { Blocklist, Item, Manifest, Progress, SortMode, TableItem } from './engine'
import { TierBadge } from './TierBadge'

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

const CHIP_HALF = { x: 40, y: 16 } // drop point is the chip centre, like the drag ghost
const SLOT = { x: 24, y: 24, dx: 96, dy: 72 }

type SlotGrid = { cols: number; rows: number }

/** Landing spots that fit on the table above the pot; 5 × 5 while the table has no layout (jsdom). */
function slotGrid(table: HTMLElement | null, pot: HTMLElement | null): SlotGrid {
  const [width, height] = [table?.clientWidth ?? 0, pot?.offsetTop ?? 0]
  if (!width || !height) return { cols: 5, rows: 5 }
  const fit = (room: number, start: number, chip: number, step: number) =>
    Math.max(1, Math.floor((room - start - chip) / step) + 1)
  return {
    cols: fit(width, SLOT.x, 2 * CHIP_HALF.x, SLOT.dx),
    rows: fit(height, SLOT.y, 2 * CHIP_HALF.y, SLOT.dy),
  }
}

/** Where the n-th item lands when it comes out of the pot. */
function slotPosition(n: number, grid: SlotGrid): { x: number; y: number } {
  return { x: SLOT.x + (n % grid.cols) * SLOT.dx, y: SLOT.y + (Math.floor(n / grid.cols) % grid.rows) * SLOT.dy }
}

function onTable(item: Item, x: number, y: number): TableItem {
  return { uid: newUid(), id: item.id, name: item.name, emoji: item.emoji, x: Math.round(x), y: Math.round(y) }
}

/** A combine that gave the player an element they did not have (AC-DISC-05): names as typed, id of the result. */
export type NewDiscovery = { a: string; b: string; result: string; id: string; emoji: string }

const VIEWS = [
  ['table', 'Bàn lẩu'],
  ['board', 'Bảng xếp hạng'],
] as const

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
  // Touch screens get a one-time "hold to drag, swipe the gaps to scroll" hint (AC-GAME-21).
  const [coarse] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  const [view, setView] = useState<'table' | 'board'>('table')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [slots, setSlots] = useState<[Item | null, Item | null]>([null, null])
  const tableRef = useRef<HTMLElement>(null)
  const potRef = useRef<HTMLDivElement>(null)
  const [boiling, setBoiling] = useState(false)
  const boilingRef = useRef(false)
  const [miss, setMiss] = useState<Miss | null>(null)
  // First discovery shown large (AC-ART-08); `seq` remounts the overlay so each discovery gets its full 2,5 s.
  const [zoom, setZoom] = useState<{ item: Item; seq: number } | null>(null)
  const showZoom = useCallback((item: Item) => setZoom((z) => ({ item, seq: (z?.seq ?? 0) + 1 })), [])
  const closeZoom = useCallback(() => setZoom(null), [])
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
    // only the first solve of a batch gets here: a solved batch returns above, even after a reload (AC-METRIC-08)
    trackEvent({ type: 'daily_complete', version: m.version })
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
    const grid = slotGrid(tableRef.current, potRef.current)
    const [pa, pb] = [slotPosition(p.table.length, grid), slotPosition(p.table.length + 1, grid)]
    later(() => {
      outcome
        .then((out) => {
          if (gen !== generation.current) return
          const table = progressRef.current?.table ?? p.table
          recordCombine(out.kind === 'hit')
          if (out.kind === 'hit') {
            const item = out.progress.items.find((i) => i.id === out.result.id)!
            commit({ ...out.progress, table: [...table, onTable(item, pa.x, pa.y)] })
            checkDaily(a.name, b.name, item)
            if (out.isNew) {
              onDiscoverRef.current?.({ a: a.name, b: b.name, result: item.name, id: item.id, emoji: item.emoji })
              showZoom(item)
            }
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
      recordCombine(out.kind === 'hit')
      if (out.kind === 'hit') {
        const item = out.progress.items.find((i) => i.id === out.result.id)!
        const rest = table.filter((t) => t.uid !== target.uid)
        commit({ ...out.progress, table: [...rest, onTable(item, target.x, target.y)] })
        checkDaily(source.item.name, target.name, item)
        if (out.isNew) {
          onDiscoverRef.current?.({ a: source.item.name, b: target.name, result: item.name, id: item.id, emoji: item.emoji })
          showZoom(item)
        }
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
  const dismissTouchHint = () => {
    const p = progressRef.current
    if (p && !p.touch_hint_seen) commit({ ...p, touch_hint_seen: true })
  }

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
      dismissTouchHint()
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
    dismissTouchHint() // before `stack`, which builds on the current progress
    if (target && ready) {
      void stack(source, target, x, y)
      return
    }
    const cur = progressRef.current ?? p
    const rest = cur.table.filter((t) => t.uid !== source.uid)
    commit({ ...cur, table: [...rest, onTable(source.item, x, y)] })
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
    setZoom(null)
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
  // No image request before the block list is known, nor for a blocked image (AC-ART-07).
  const imageOf = (item: Item | undefined): string | null =>
    loaded && item?.image_key && !blocklist.images.includes(item.id) ? item.image_key : null
  const badge = (item: Item | undefined) => (item && isNew(item, version, blocklist) ? <span className="badge">MỚI</span> : null)

  return (
    <div className="game">
      {/* Title, account and theme only (AC-GAME-19); the table controls live with the table. */}
      <header className="game-bar">
        <h1>Lẩu Meme</h1>
        <div className="game-actions">
          {loaded && <AuthBar policyVersion={loaded.manifest.policy_version} storage={storage()} />}
          <button type="button" className="icon-button" onClick={toggleTheme} aria-label="Chuyển chế độ sáng/tối">
            <ThemeIcon dark={theme === 'dark'} />
          </button>
        </div>
      </header>

      {/* Two screens: the table and the leaderboards (AC-DAILY-17); the table keeps its state while hidden. */}
      {/* No leaderboards without a manifest: after a load error the table (and its retry) stays in view. */}
      {loaded && (
        <div role="tablist" aria-label="Màn hình" className="view-tabs">
          {VIEWS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </div>
      )}

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
          onShowBoard={() => setView('board')}
        />
      )}

      {view === 'board' && loaded && <Leaderboards version={loaded.manifest.version} />}

      <div className="game-board" hidden={loaded !== null && view !== 'table'}>
        <div className="table-area">
          <div className="table-tools">
            <button type="button" onClick={clearTable}>
              Dọn bàn
            </button>
            <button type="button" onClick={() => setConfirmReset(true)} aria-label="Chơi lại từ đầu">
              Chơi lại <span className="wide-only">từ đầu</span>
            </button>
            <button type="button" onClick={() => setTutorialOpen(true)} title="Hướng dẫn">
              ?
            </button>
          </div>
          <section ref={tableRef} className="game-table" data-testid="table" aria-label="Mặt bàn">
          {table.map((t) => (
            <div
              key={t.uid}
              className={`chip on-table tier-${tierOf(byId.get(t.id))}`}
              data-tier={tierOf(byId.get(t.id))}
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
              <ElementIcon emoji={t.emoji} imageKey={imageOf(byId.get(t.id))} /> <span>{t.name}</span>
              {badge(byId.get(t.id))}
              <TierBadge tier={tierOf(byId.get(t.id))} />
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
                    {it && (
                      <span className={`slot-item tier-${tierOf(byId.get(it.id) ?? it)}`} data-tier={tierOf(byId.get(it.id) ?? it)}>
                        <span aria-hidden="true">{it.emoji}</span> <span>{it.name}</span>
                        <TierBadge tier={tierOf(byId.get(it.id) ?? it)} />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <span className="pot-body" data-testid="pot-body" aria-hidden="true">
              <i className="pot-handle left" data-testid="pot-handle-left" />
              <i className="pot-handle right" data-testid="pot-handle-right" />
            </span>
            <span className="pot-burner" data-testid="pot-flames" aria-hidden="true" />
          </div>
          {zoom && (
            <DiscoveryZoom
              key={zoom.seq}
              name={zoom.item.name}
              emoji={zoom.item.emoji}
              imageKey={imageOf(zoom.item)}
              tier={tierOf(zoom.item)}
              onClose={closeZoom}
            />
          )}
          <div className="sr-only" aria-live="polite">
            {zoom ? `Món mới: ${zoom.item.name}` : ''}
          </div>
          <div className="miss" aria-live="polite">
            {miss && <p data-testid="miss-line">{miss.line}</p>}
            {miss?.hint && <p data-testid="miss-hint">{miss.hint}</p>}
          </div>
        </section>
          {coarse && progress && !progress.touch_hint_seen && (
            <p className="touch-hint">
              <span>Giữ món để kéo, vuốt chỗ trống để cuộn</span>
              <button type="button" className="icon-button" onClick={dismissTouchHint} aria-label="Đóng gợi ý">
                ×
              </button>
            </p>
          )}
        </div>

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
                className={`chip tier-${tierOf(it)}`}
                data-tier={tierOf(it)}
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
                <ElementIcon emoji={it.emoji} imageKey={imageOf(it)} /> <span>{it.name}</span>
                {badge(it)}
                <TierBadge tier={tierOf(it)} />
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
                    <FlagIcon />
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

/** Outline sun (switch to light) or moon (switch to dark), drawn in the text colour. */
function ThemeIcon({ dark }: { dark: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {dark ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      ) : (
        <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
      )}
    </svg>
  )
}

/** Outline flag for the "Báo cáo" button on plate items. */
function FlagIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  )
}
