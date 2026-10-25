import { useEffect, useState } from 'react'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/**
 * Share cards (AC-SHARE-01..06): text and a 1080×1080 PNG built in the browser, never by the server. A card never
 * carries the answer: callers pass only what is printed, and the builders read only the fields below.
 */
export type DailyCardData = {
  /** 'YYYY-MM-DD' of the batch in GMT+7. */
  day: string
  /** Hour of the batch in GMT+7. */
  batchHour: number
  emoji: string
  /** Solve time computed by the server (AC-DAILY-06), in seconds. */
  solveSeconds: number
  /** Rank in the batch; null when no result could be submitted. */
  rank: number | null
  /** Home page; the card adds `?ref=daily`. */
  link: string
}
export type DiscCardData = { emoji: string; name: string; nickname: string; link: string }
export type ShareKind = 'daily' | 'discovery'
type Method = 'native' | 'copy' | 'image'

const SIZE = 1080
const PNG_NAME = 'lau-meme.png'
const pad2 = (n: number) => String(n).padStart(2, '0')

/** Floors to the minute (AC-SHARE-02): "dưới 1 phút", "45 phút", "26 giờ 03 phút". */
export function formatShareTime(solveSeconds: number): string {
  const minutes = Math.floor(Math.max(0, solveSeconds) / 60)
  if (minutes === 0) return 'dưới 1 phút'
  const [h, m] = [Math.floor(minutes / 60), minutes % 60]
  return h > 0 ? `${h} giờ ${pad2(m)} phút` : `${m} phút`
}

function dailyLines(d: DailyCardData): [string, string, string] {
  const [, month, day] = d.day.split('-')
  const rank = d.rank === null ? '' : ` · hạng #${d.rank}`
  return [
    `Lẩu Meme 🍲 Món đặc biệt ${day}/${month} · mẻ ${d.batchHour}h`,
    `${d.emoji} giải sau ${formatShareTime(d.solveSeconds)}${rank}`,
    `${d.link}?ref=daily`,
  ]
}

export function buildDailyCardText(d: DailyCardData): string {
  return dailyLines(d).join('\n')
}

function discLines(d: DiscCardData): [string, string] {
  return [
    `Mình là người đầu tiên nấu ra ${d.emoji} ${d.name} trên Lẩu Meme - Công thức gia truyền của ${d.nickname}`,
    `${d.link}?ref=disc`,
  ]
}

export function buildDiscCardText(d: DiscCardData): string {
  return discLines(d).join('\n')
}

/** Splits `text` into lines no wider than `max` px. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > max) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** The hot-pot card (AC-SHARE-03/04): logo, a pot with the dish emoji, the card's lines and the link. */
export function drawCardPng(canvas: HTMLCanvasElement, card: 'daily', data: DailyCardData): void
export function drawCardPng(canvas: HTMLCanvasElement, card: 'discovery', data: DiscCardData): void
export function drawCardPng(canvas: HTMLCanvasElement, card: ShareKind, data: DailyCardData | DiscCardData): void
export function drawCardPng(canvas: HTMLCanvasElement, card: ShareKind, data: DailyCardData | DiscCardData): void {
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // colour emoji fonts before the generic family, or the emoji in the text are drawn as outlines or boxes
  const font = (px: number, weight = 600) =>
    `${weight} ${px}px system-ui, -apple-system, "Segoe UI", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`

  ctx.fillStyle = '#f2f8f4'
  ctx.fillRect(0, 0, SIZE, SIZE)
  // the pot: broth, rim and two handles
  ctx.fillStyle = '#7d8a85'
  ctx.fillRect(170, 470, 60, 40)
  ctx.fillRect(850, 470, 60, 40)
  ctx.fillStyle = '#c9d3cf'
  ctx.beginPath()
  ctx.ellipse(540, 490, 330, 240, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#e0533b'
  ctx.beginPath()
  ctx.ellipse(540, 490, 290, 205, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#0a8a43'
  ctx.font = font(84, 800)
  ctx.fillText('Lẩu Meme', 540, 120)

  const daily = card === 'daily' ? (data as DailyCardData) : null
  const [head, body, link] = daily
    ? dailyLines(daily)
    : ['Công thức gia truyền', ...discLines(data as DiscCardData)]
  ctx.fillStyle = '#0c1511'
  ctx.font = font(44)
  ctx.fillText(daily ? head.replace(/^Lẩu Meme 🍲 /, '') : head, 540, 210)

  ctx.font = `400 200px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
  ctx.fillText(data.emoji, 540, 470)

  ctx.font = font(46)
  // Under the "Công thức gia truyền" header the PNG says it shorter than the text card; the nickname keeps its own
  // line, and 3 lines at most never run into the link.
  const lines = daily
    ? wrap(ctx, body.replace(`${data.emoji} `, ''), 900)
    : [
        ...wrap(ctx, `Người đầu tiên nấu ra ${(data as DiscCardData).name}`, 900).slice(0, 2),
        `của ${(data as DiscCardData).nickname}`,
      ]
  lines.slice(0, 3).forEach((line, i) => ctx.fillText(line, 540, 800 + i * 60))

  ctx.fillStyle = '#56665e'
  ctx.font = font(34, 500)
  ctx.fillText(link, 540, 1010)
}

function cardText(card: ShareKind, data: DailyCardData | DiscCardData): string {
  return card === 'daily' ? buildDailyCardText(data as DailyCardData) : buildDiscCardText(data as DiscCardData)
}

function pngBlob(card: ShareKind, data: DailyCardData | DiscCardData): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  drawCardPng(canvas, card, data)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

/** No player options: the consent check fails, so nothing is sent. */
const NO_CONSENT: PlayerOpts = { storage: null, policyVersion: Number.NaN }

/** AC-SHARE-06: only through the consent-gated client; a refusal or a failure never bothers the player. */
function logShare(player: PlayerOpts, card: ShareKind, method: Method): void {
  const body = JSON.stringify({ events: [{ type: 'share', card, method }] })
  playerFetch('api/events', { method: 'POST', body }, player).catch(() => undefined)
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'

type Props = ({ card: 'daily'; data: DailyCardData } | { card: 'discovery'; data: DiscCardData }) & {
  player?: PlayerOpts
}

/**
 * "Chia sẻ" opens the system share sheet (with the PNG when the browser accepts files), else copies the text;
 * "Sao chép" always copies; "Lưu ảnh" downloads the PNG (AC-SHARE-05). Cancelling the sheet is not an error.
 */
export function ShareCard({ card, data, player = NO_CONSENT }: Props) {
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const text = cardText(card, data)

  // Built ahead so the click can call navigator.share at once (browsers require a fresh user gesture).
  useEffect(() => {
    let live = true
    pngBlob(card, data).then((blob) => live && blob && setFile(new File([blob], PNG_NAME, { type: 'image/png' })))
    return () => {
      live = false
    }
  }, [card, data])

  const done = (method: Method, message: string | null) => {
    setError(null)
    setToast(message)
    logShare(player, card, method)
  }
  // No clipboard outside a secure context (and in some webviews): say so instead of failing silently.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      done('copy', 'Đã sao chép')
    } catch {
      setError('Không sao chép được, thử lại sau.')
    }
  }

  const share = async () => {
    if (typeof navigator.share !== 'function') return copy()
    const png = file ?? (await pngBlob(card, data).then((b) => b && new File([b], PNG_NAME, { type: 'image/png' })))
    const files = png && navigator.canShare?.({ files: [png] }) ? [png] : undefined
    return navigator.share(files ? { text, files } : { text }).then(
      () => done('native', null),
      (err: unknown) => !isAbort(err) && setError('Không chia sẻ được, thử lại sau.'),
    )
  }

  const save = () =>
    pngBlob(card, data).then((blob) => {
      if (!blob) return setError('Không tạo được ảnh, thử lại sau.')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = PNG_NAME
      // iOS Safari only follows a link that is in the page; revoking at once cancels the download in some browsers.
      document.body.append(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      done('image', null)
    })

  return (
    <div className="share-card" role="group" aria-label="Thẻ chia sẻ">
      <button type="button" onClick={() => void share()}>
        Chia sẻ
      </button>
      <button type="button" onClick={() => void copy()}>
        Sao chép
      </button>
      <button type="button" onClick={() => void save()}>
        Lưu ảnh
      </button>
      {toast && <span role="status">{toast}</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
