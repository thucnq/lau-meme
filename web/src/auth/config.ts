/**
 * Google OAuth client ID of this build (public, not a secret): the `aud` the Worker accepts (wrangler.jsonc vars
 * GOOGLE_CLIENT_ID). One bundle serves both environments (deploy.yml builds web the same way for each), so the
 * client is picked by host: the staging host gets the staging client, every other host production.
 * VITE_GOOGLE_CLIENT_ID, when set at build time, overrides both.
 */
const PRODUCTION_CLIENT_ID = '983893414114-5s71asl52rc0c5o5pffdnbfa1n0uc2r1.apps.googleusercontent.com'
const STAGING_CLIENT_ID = '983893414114-4fqirgtmr60j2ae9mumhtuuthr31vl4c.apps.googleusercontent.com'
const STAGING_HOST = 'staging.dinoduct.fun'

export function clientIdFor(host: string): string {
  return host === STAGING_HOST ? STAGING_CLIENT_ID : PRODUCTION_CLIENT_ID
}

export const GOOGLE_CLIENT_ID: string =
  import.meta.env.VITE_GOOGLE_CLIENT_ID || clientIdFor(typeof location === 'undefined' ? '' : location.hostname)
