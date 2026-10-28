import { bannedKey } from '../disc/disc'
import { NICKNAME } from '../player/me'

/** The nickname for one mQuiz room (AC-QUIZ-02/05): the AC-DISC-02/03 rules, never saved as the player's nickname. */
export function roomNickname(raw: string): string | null {
  const nickname = raw.trim()
  const length = [...nickname].length
  return length >= 2 && length <= 20 && NICKNAME.test(nickname) ? nickname : null
}

export function bannedTermsStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT DISTINCT term_fold FROM banned_term')
}

/** True when a banned word or alias appears in the nickname (folded, letters and digits only). */
export function isBanned(nickname: string, banned: D1Result | undefined): boolean {
  const key = bannedKey(nickname)
  return ((banned?.results ?? []) as Array<{ term_fold: string }>).some(({ term_fold }) => {
    const term = bannedKey(term_fold)
    return term !== '' && key.includes(term)
  })
}
