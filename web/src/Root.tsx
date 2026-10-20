import { useEffect, useState } from 'react'
import { getManifest } from './api'
import { App } from './App'
import { withBase } from './base'
import { Game } from './game/Game'
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
      <Game />
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
