import { useState } from 'react'
import { withBase } from '../base'
import { QuizPanel } from './QuizPanel'
import { QuizRoom } from './QuizRoom'

const ROOM_PATH = /\/quiz\/([2-9A-HJKMNP-Z]{6})\/?$/

/** Room code of a `<base>/quiz/<code>` link (AC-QUIZ-03, AC-SUBPATH-05), or null. */
export function roomFromPath(pathname: string): string | null {
  return ROOM_PATH.exec(pathname)?.[1] ?? null
}

/** The mQuiz tab: the panel, or one room; the address bar follows so a reload (F5) opens the same room. */
export function QuizScreen({ policyVersion }: { policyVersion?: number }) {
  const [code, setCode] = useState(() => roomFromPath(window.location.pathname))
  const go = (next: string | null) => {
    try {
      window.history.pushState(null, '', withBase(next ? `quiz/${next}` : ''))
    } catch {
      // no history API: the room still opens, a reload just lands on the game
    }
    setCode(next)
  }
  return code ? <QuizRoom key={code} code={code} onLeave={() => go(null)} /> : <QuizPanel policyVersion={policyVersion} onOpenRoom={go} />
}
