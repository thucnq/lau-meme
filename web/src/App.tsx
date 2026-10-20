import { useEffect, useState } from 'react'
import { getHealth, type Health } from './api'

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    getHealth(ctrl.signal).then(setHealth, (e: unknown) => {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(true)
    })
    return () => ctrl.abort()
  }, [])

  return (
    <footer className="health">
      {error ? (
        <p role="alert">Không kết nối được máy chủ.</p>
      ) : (
        <p>{health ? `Máy chủ: ${health.status} (${health.env})` : 'Đang kiểm tra…'}</p>
      )}
    </footer>
  )
}
