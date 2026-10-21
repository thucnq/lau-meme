import { useEffect, useRef, useState } from 'react'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import { canSend } from '../privacy/consent'
import { getSession, signIn, signOut, type SessionInfo } from './api'
import { GOOGLE_CLIENT_ID } from './config'
import { setCurrentSession } from './session'

/** The part of Google Identity Services (https://accounts.google.com/gsi/client) this bar uses. */
type GoogleId = {
  initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void
  renderButton: (el: HTMLElement, options: Record<string, string>) => void
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } }
  }
}

/** Shown for an account without a nickname (same words as the leaderboards). */
const ANONYMOUS = 'Thực khách ẩn danh'
const GSI_SRC = 'https://accounts.google.com/gsi/client'
let gsiLoading: Promise<GoogleId> | null = null

/** Loads the GIS script once per page; resolves with `google.accounts.id`. */
function loadGoogleId(): Promise<GoogleId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id)
  gsiLoading ??= new Promise<GoogleId>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GSI_SRC
    script.async = true
    script.onload = () => (window.google ? resolve(window.google.accounts.id) : reject(new Error('GIS missing')))
    script.onerror = () => {
      gsiLoading = null
      reject(new Error('GIS failed to load'))
    }
    document.head.appendChild(script)
  })
  return gsiLoading
}

type Props = { policyVersion: number; storage: Storage | null; onChange?: (s: SessionInfo | null) => void }
type State = { kind: 'loading' } | { kind: 'out' } | { kind: 'in'; session: SessionInfo }

/**
 * Sign in with Google (AC-AUTH-01/02/05): optional for playing. Without consent the button only invites the
 * player to agree first; with consent it is Google's own button, whose ID token goes to the Worker once.
 */
export function AuthBar({ policyVersion, storage, onChange }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [askConsent, setAskConsent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const googleSlot = useRef<HTMLDivElement>(null)
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  }, [onChange])
  const consented = canSend(storage, policyVersion)

  // the rest of the page (Món đặc biệt) follows the sign-in state from here
  useEffect(() => {
    if (state.kind !== 'loading') setCurrentSession(state.kind === 'in' ? state.session : null)
  }, [state])

  useEffect(() => {
    let live = true
    getSession().then(
      (s) => {
        if (!live) return
        setState(s ? { kind: 'in', session: s } : { kind: 'out' })
        changed.current?.(s)
      },
      () => live && setState({ kind: 'out' }),
    )
    return () => {
      live = false
    }
  }, [])

  // Google's button, drawn into the slot whenever the signed-out view with consent is on screen.
  useEffect(() => {
    if (state.kind !== 'out' || !consented) return
    let live = true
    loadGoogleId().then(
      (id) => {
        const slot = googleSlot.current
        if (!live || !slot) return
        id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: ({ credential }) => {
            setError(null)
            signIn(credential, { storage, policyVersion }).then(
              (session) => {
                setState({ kind: 'in', session })
                changed.current?.(session)
              },
              () => setError('Không đăng nhập được, thử lại sau.'),
            )
          },
        })
        slot.replaceChildren()
        id.renderButton(slot, { type: 'standard', theme: 'outline', text: 'signin_with', locale: 'vi' })
      },
      () => live && setError('Không tải được nút đăng nhập Google.'),
    )
    return () => {
      live = false
    }
  }, [state.kind, consented, storage, policyVersion])

  const out = () => {
    setError(null)
    signOut().then(
      () => {
        setState({ kind: 'out' })
        changed.current?.(null)
      },
      () => setError('Không đăng xuất được, thử lại sau.'),
    )
  }

  if (state.kind === 'loading') return null
  return (
    <div className="auth-bar">
      {state.kind === 'in' ? (
        <>
          <span role="status">
            Đã đăng nhập: <strong>{state.session.nickname ?? ANONYMOUS}</strong>
          </span>{' '}
          <button type="button" onClick={out}>
            Đăng xuất
          </button>
        </>
      ) : consented ? (
        <div ref={googleSlot} className="google-signin" />
      ) : (
        <>
          <button type="button" onClick={() => setAskConsent(true)}>
            Đăng nhập bằng Google
          </button>
          {askConsent && <ConsentPrompt />}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
