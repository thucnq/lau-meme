import { useCallback, useEffect, useRef, useState } from 'react'
import { getManifest } from './api'
import { AuthBar } from './auth/AuthBar'
import { App } from './App'
import { withBase } from './base'
import { SendError, heirloomLine, listDiscoveries, submitDiscovery } from './disc/api'
import { ConsentRequiredError } from './privacy/client'
import { Game, type NewDiscovery } from './game/Game'
import { ConsentPrompt } from './privacy/ConsentPrompt'
import { canSend } from './privacy/consent'
import { ReportDialog } from './report/ReportDialog'
import { ConsentBanner } from './privacy/ConsentBanner'
import { MyDataPanel } from './privacy/MyDataPanel'
import { PolicyPage } from './privacy/PolicyPage'
import { localStore } from './storage'

/** Two screens, no router: the policy page at `<base>/chinh-sach` (AC-PRIV-01), the game everywhere else. */
export function Root() {
  if (window.location.pathname.replace(/\/+$/, '').endsWith('/chinh-sach')) return <PolicyPage />
  return <Home />
}

/** Outcome of the last discovery send: the heirloom line, a consent invitation, or an error text. */
type Notice = { kind: 'heirloom'; line: string; first: boolean } | { kind: 'consent' } | { kind: 'error'; text: string }

function Home() {
  const [storage] = useState(localStore)
  const [policyVersion, setPolicyVersion] = useState<number | null>(null)
  const [myDataOpen, setMyDataOpen] = useState(false)
  const [bannerKey, setBannerKey] = useState(0) // remount = ask again (after erasure the new id has no consent)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [heirlooms, setHeirlooms] = useState<Record<string, string>>({})
  const [blocklistRefresh, setBlocklistRefresh] = useState(0)
  const [reporting, setReporting] = useState<{ id: string; name: string; image_key: string | null } | null>(null)
  const asked = useRef(new Set<string>())

  // Who first found each element on the plate (AC-DISC-09): a public read, each id asked once per visit.
  const lookUp = useCallback((ids: string[]) => {
    const fresh = ids.filter((id) => !asked.current.has(id))
    if (fresh.length === 0) return
    fresh.forEach((id) => asked.current.add(id))
    listDiscoveries(fresh).then(
      (found) =>
        setHeirlooms((prev) => ({
          ...prev,
          ...Object.fromEntries(found.map((d) => [d.element_id, heirloomLine(d.nickname)])),
        })),
      () => fresh.forEach((id) => asked.current.delete(id)),
    )
  }, [])

  // Công thức gia truyền (AC-DISC-05/06): only with consent; a failed or limited send just shows nothing.
  const discover = (d: NewDiscovery) => {
    setNotice(null)
    if (policyVersion === null) return
    if (!canSend(storage, policyVersion)) return setNotice({ kind: 'consent' })
    submitDiscovery({ a: d.a, b: d.b, result: d.result }, { storage, policyVersion }).then(
      (r) => {
        const line = heirloomLine(r.nickname)
        setNotice({ kind: 'heirloom', line, first: r.first })
        setHeirlooms((prev) => ({ ...prev, [r.element_id]: line }))
      },
      (err: unknown) => {
        if (err instanceof ConsentRequiredError) return setNotice({ kind: 'consent' })
        const text =
          err instanceof SendError && err.status === 429
            ? 'Gửi quá nhanh, thử lại sau.'
            : 'Không gửi được khám phá, thử lại sau.'
        setNotice({ kind: 'error', text })
      },
    )
  }

  // The current policy version comes from the manifest; until it is known nothing can be sent (AC-PRIV-09).
  useEffect(() => {
    const ctrl = new AbortController()
    getManifest(ctrl.signal).then(
      (m) => setPolicyVersion(m.policy_version),
      () => undefined,
    )
    return () => ctrl.abort()
  }, [])

  return (
    <>
      <Game
        onDiscover={discover}
        onItems={lookUp}
        heirlooms={heirlooms}
        onReport={setReporting}
        blocklistRefresh={blocklistRefresh}
      />
      {reporting && policyVersion !== null && (
        <ReportDialog
          key={reporting.id}
          item={reporting}
          policyVersion={policyVersion}
          storage={storage}
          onClose={() => setReporting(null)}
          onSent={() => setBlocklistRefresh((n) => n + 1)}
        />
      )}
      {notice?.kind === 'consent' && <ConsentPrompt />}
      {notice?.kind === 'error' && <p role="status">{notice.text}</p>}
      {notice?.kind === 'heirloom' && (
        <p className="heirloom" role="status">
          {notice.first && 'Bạn là người đầu tiên! '}
          {notice.line}
        </p>
      )}
      {policyVersion !== null && <ConsentBanner key={bannerKey} policyVersion={policyVersion} storage={storage} />}
      {myDataOpen && policyVersion !== null && (
        <MyDataPanel policyVersion={policyVersion} storage={storage} onErased={() => setBannerKey((k) => k + 1)} />
      )}
      <nav className="site-links">
        {policyVersion !== null && <AuthBar policyVersion={policyVersion} storage={storage} />}
        <a href={withBase('chinh-sach')}>Chính sách quyền riêng tư</a>
        <button type="button" onClick={() => setMyDataOpen((open) => !open)} aria-expanded={myDataOpen}>
          Dữ liệu của tôi
        </button>
      </nav>
      <App />
    </>
  )
}
