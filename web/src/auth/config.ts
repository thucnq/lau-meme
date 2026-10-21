/**
 * Google OAuth client ID of this build (public, not a secret): the `aud` the Worker accepts (wrangler.jsonc vars
 * GOOGLE_CLIENT_ID). Builds for staging set VITE_GOOGLE_CLIENT_ID to the staging client; the default is production.
 */
const PRODUCTION_CLIENT_ID = '983893414114-5s71asl52rc0c5o5pffdnbfa1n0uc2r1.apps.googleusercontent.com'

export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || PRODUCTION_CLIENT_ID
