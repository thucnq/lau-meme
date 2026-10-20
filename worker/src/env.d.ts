// Bindings declared in wrangler.jsonc. Keep in sync (or generate with `npx wrangler types`).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    ASSETS: Fetcher
    APP_ENV: string
    ADMIN_TOKEN?: string
    PIPELINE_TOKEN?: string
    POLICY_VERSION?: string
    IP_HASH_KEY?: string
  }
}
type Env = Cloudflare.Env
