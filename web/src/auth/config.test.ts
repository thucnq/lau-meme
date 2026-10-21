import { describe, expect, it } from 'vitest'
import { clientIdFor } from './config'

const STAGING = '983893414114-4fqirgtmr60j2ae9mumhtuuthr31vl4c.apps.googleusercontent.com'
const PRODUCTION = '983893414114-5s71asl52rc0c5o5pffdnbfa1n0uc2r1.apps.googleusercontent.com'

describe('clientIdFor', () => {
  it('AC-AUTH-01: staging.dinoduct.fun dùng Client ID staging (khớp GOOGLE_CLIENT_ID của Worker staging)', () => {
    expect(clientIdFor('staging.dinoduct.fun')).toBe(STAGING)
  })

  it('AC-AUTH-01: dinoduct.fun, localhost và mọi tên miền khác dùng Client ID production', () => {
    for (const host of ['dinoduct.fun', 'localhost', 'laumeme-admin-staging.dinoduct.fun', ''])
      expect(clientIdFor(host)).toBe(PRODUCTION)
  })
})
