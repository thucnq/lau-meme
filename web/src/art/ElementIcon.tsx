import { useEffect, useRef, useState } from 'react'
import { withBase } from '../base'

type Props = {
  emoji: string
  /** `<sha256-12>.webp`, or null when the element has no image, its image is blocked or the block list is unknown. */
  imageKey: string | null
}

type Status = 'loading' | 'loaded' | 'failed'

/**
 * Emoji first, image after (AC-ART-06): the emoji shows at once and gives way once the image has loaded; a failed
 * image is dropped for good (no retry, no broken-image icon). A null key never requests anything (AC-ART-07).
 */
export function ElementIcon({ emoji, imageKey }: Props) {
  const [state, setState] = useState<{ key: string | null; status: Status }>({ key: imageKey, status: 'loading' })
  if (state.key !== imageKey) setState({ key: imageKey, status: 'loading' })
  const status: Status = state.key === imageKey ? state.status : 'loading'
  const showImage = imageKey !== null && status !== 'failed'
  const ref = useRef<HTMLImageElement>(null)

  // src is assigned here, once, after the listeners: React 19 assigns an <img src> prop a second time on mount.
  useEffect(() => {
    const img = ref.current
    if (!img || imageKey === null) return
    const onLoad = () => setState({ key: imageKey, status: 'loaded' })
    const onError = () => setState({ key: imageKey, status: 'failed' })
    img.addEventListener('load', onLoad)
    img.addEventListener('error', onError)
    img.src = withBase(`img/${imageKey}`)
    return () => {
      img.removeEventListener('load', onLoad)
      img.removeEventListener('error', onError)
    }
  }, [imageKey, showImage])

  return (
    <>
      {status !== 'loaded' || !showImage ? <span className="emoji" aria-hidden="true">{emoji}</span> : null}
      {showImage && (
        <img ref={ref} className={status === 'loaded' ? 'art' : 'art loading'} alt="" aria-hidden="true" draggable={false} />
      )}
    </>
  )
}
