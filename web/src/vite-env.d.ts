/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute public URL of the game, with a trailing slash (vite.config.ts; default https://dinoduct.fun/lau-meme/). */
  readonly VITE_SITE_URL: string
  /** Google OAuth client ID for Sign in with Google (auth/config.ts); unset means the production client. */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}
