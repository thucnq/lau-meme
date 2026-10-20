// Bindings declared in wrangler.jsonc. Keep in sync (or generate with `npx wrangler types`).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    ASSETS: Fetcher
    APP_ENV: string
    /** Sub-path the game lives under, no trailing slash (base-path.json, ADR 0007). */
    BASE_PATH: string
    /** Host of the admin page and API (ADR 0008); requests to any other host never reach /api/admin/*. */
    ADMIN_HOST: string
    ADMIN_TOKEN?: string
    PIPELINE_TOKEN?: string
    POLICY_VERSION?: string
    IP_HASH_KEY?: string
  }
}
type Env = Cloudflare.Env
