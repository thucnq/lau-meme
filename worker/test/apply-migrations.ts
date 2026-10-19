import { applyD1Migrations, env } from 'cloudflare:test'

// Every test file starts from the committed migrations, exactly like staging/production.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
