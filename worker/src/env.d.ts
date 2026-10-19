// Bindings declared in wrangler.jsonc. Keep in sync (or generate with `npx wrangler types`).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    ASSETS: Fetcher
    APP_ENV: string
    ADMIN_TOKEN?: string
  }
}
type Env = Cloudflare.Env
