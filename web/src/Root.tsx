import { useEffect, useState } from 'react'
import { getManifest } from './api'
import { App } from './App'
import { withBase } from './base'
import { heirloomLine, submitDiscovery } from './disc/api'
import { Game, type NewDiscovery } from './game/Game'
import { ConsentPrompt } from './privacy/ConsentPrompt'
import { canSend } from './privacy/consent'
import { ConsentBanner } from './privacy/ConsentBanner'
import { MyDataPanel } from './privacy/MyDataPanel'
import { PolicyPage } from './privacy/PolicyPage'
import { localStore } from './storage'

/** Two screens, no router: the policy page at `<base>/chinh-sach` (AC-PRIV-01), the game everywhere else. */
export function Root() {
  if (window.location.pathname.replace(/\/+$/, '').endsWith('/chinh-sach')) return <PolicyPage />
  return <Home />
}

function Home() {
  const [storage] = useState(localStore)
  const [policyVersion, setPolicyVersion] = useState<number | null>(null)
  const [myDataOpen, setMyDataOpen] = useState(false)
  const [bannerKey, setBannerKey] = useState(0) // remount = ask again (after erasure the new id has no consent)
  const [heirloom, setHeirloom] = useState<{ line: string; first: boolean } | 'consent' | null>(null)

  // Công thức gia truyền (AC-DISC-05/06): only with consent; a failed or limited send just shows nothing.
  const discover = (d: NewDiscovery) => {
    setHeirloom(null)
    if (policyVersion === null) return
    if (!canSend(storage, policyVersion)) return setHeirloom('consent')
    submitDiscovery({ a: d.a, b: d.b, result: d.result }, { storage, policyVersion }).then(
      (r) => setHeirloom({ line: heirloomLine(r.nickname), first: r.first }),
      () => undefined,
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
      <Game onDiscover={discover} />
      {heirloom === 'consent' && <ConsentPrompt />}
      {heirloom !== null && heirloom !== 'consent' && (
        <p className="heirloom" role="status">
          {heirloom.first && 'Bạn là người đầu tiên! '}
          {heirloom.line}
        </p>
      )}
      {policyVersion !== null && <ConsentBanner key={bannerKey} policyVersion={policyVersion} storage={storage} />}
      {myDataOpen && policyVersion !== null && (
        <MyDataPanel policyVersion={policyVersion} storage={storage} onErased={() => setBannerKey((k) => k + 1)} />
      )}
      <nav className="site-links">
        <a href={withBase('chinh-sach')}>Chính sách quyền riêng tư</a>
        <button type="button" onClick={() => setMyDataOpen((open) => !open)} aria-expanded={myDataOpen}>
          Dữ liệu của tôi
        </button>
      </nav>
      <App />
    </>
  )
}
