# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

wacrm — a self-hostable WhatsApp CRM **template** (fork → customise → deploy). Next.js 16 App Router + React 19 + TypeScript + Tailwind v4, Supabase (Postgres/Auth/Storage/RLS), Meta WhatsApp Cloud API. Node >= 22.12. Upstream scope is deliberately narrow: bug/security fixes over new features (see CONTRIBUTING.md).

## Commands

```bash
npm run dev            # Turbopack dev server on :3000
npm run build          # production build (output: standalone)
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest run (all src/**/*.test.ts[x])
npx vitest run src/lib/whatsapp/encryption.test.ts   # single file
npx vitest run -t "name of test"                       # single test by name
npm run format         # prettier --write (run before PRs, with typecheck)
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build with dummy env vars. A separate `migrations.yml` replays every migration on a clean local Postgres via the Supabase CLI (`supabase db start && supabase db reset --local --no-seed`), then runs `supabase/ci/verify-schema.sql`.

Tests run in the `node` environment and never touch real Supabase/Meta. `vitest.config.ts` sets dummy `ENCRYPTION_KEY` / `META_APP_SECRET` because `lib/whatsapp/encryption.ts` and the webhook signature code read them at module load.

## Environment

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (64 hex chars, AES-256-GCM for stored WhatsApp/AI tokens — rotating it orphans existing ciphertext), `META_APP_SECRET` (comma-separated list allowed for multiple Meta Apps, see docs/multi-waba.md). Notable optional: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_LOCALE` (build-time inlined), `AUTOMATION_CRON_SECRET`, `ALLOWED_DEV_ORIGINS`.

## Architecture

### Multi-tenancy and auth
Everything is **account-scoped**. Users belong to accounts via memberships with roles `owner > admin > agent > viewer` (`src/lib/auth/roles.ts`). The TS rank mirrors the SQL `is_account_member(account_id, min_role)` helper that RLS policies use — keep them aligned, and use the role predicates in `roles.ts` rather than open-coding role checks.

Three ways code reaches the database — pick deliberately:
- **Cookie session** (`src/lib/supabase/server.ts` / `client.ts`): dashboard pages and internal `/api/*` routes. RLS enforces access; `getCurrentAccount()` in `src/lib/auth/account.ts` resolves the user's account. The browser client is a singleton on purpose (auth-lock contention).
- **Service-role client** (`supabaseAdmin()` in `lib/flows/admin-client.ts`, `lib/automations/admin-client.ts`, `lib/ai/admin-client.ts`): webhook, cron, engines, and the public API. **Bypasses RLS — every query must filter by `account_id` explicitly.**
- **API key** (`requireApiKey(request, scope)` in `src/lib/auth/api-context.ts`): all `/api/v1/*` routes. Resolves `Bearer wacrm_live_…` to `{ supabase (service-role), accountId, scopes }`; errors go through `toApiErrorResponse` / `lib/api/v1/respond.ts`. Scopes live in `lib/api-keys/scopes.ts`. Docs: docs/public-api.md.

`src/middleware.ts` refreshes the Supabase session and handles auth redirects; any response it returns must carry the refreshed cookies (`withRefreshedCookies`) or sessions wedge.

### Inbound message pipeline
`src/app/api/whatsapp/webhook/route.ts` is the hub: verifies the Meta HMAC signature, resolves the account by phone number id, dedupes/creates contacts (`lib/contacts/dedupe.ts`) and conversations, mirrors media to Supabase Storage, applies delivery status updates (`lib/whatsapp/message-status-sync.ts`), then fans out (largely via `after()`) to:
- `lib/flows/engine.ts` — conversational node-graph flows (beta, per-account opt-in); reports whether it consumed the message
- `lib/automations/engine.ts` — trigger/condition/action automations, including resuming "await reply" waits
- `lib/ai/auto-reply.ts` — optional AI auto-reply bot with handoff
- `lib/webhooks/deliver.ts` — signed outbound webhooks to user endpoints (SSRF-guarded in `ssrf.ts`)

The engines rely on DB-level idempotency (unique indexes, `meta_message_id`, optimistic conditional UPDATEs) because Meta retries webhooks; preserve these guards when editing.

Scheduled work (delayed automation steps, flow timeouts) is drained by `GET /api/automations/cron` and `/api/flows/cron`, protected by the `x-cron-secret` header against `AUTOMATION_CRON_SECRET` and triggered by an external scheduler.

Outbound Meta calls go through `lib/whatsapp/meta-api.ts`; Meta errors are translated for users in `meta-error-explain.ts`.

### Code layout
- `src/app/(dashboard)/*` — feature pages (inbox, contacts, pipelines, broadcasts, automations, flows, agents, settings); `src/app/(auth)` — login/signup; `src/app/join` — invite redemption.
- `src/lib/<domain>/` — business logic, mostly pure and unit-tested next to the source (`foo.ts` + `foo.test.ts`). Prefer putting logic here and keeping route handlers thin.
- `src/components/<domain>/` — UI; `src/components/ui` is shadcn (base-ui based, see `components.json`).
- `mcp-server/` — separate npm package (`wacrm-mcp`) exposing the public API over MCP; own `package.json`/build. Docs: docs/mcp.md.

### Database
`supabase/migrations/NNN_name.sql`, numbered sequentially and applied in filename order. Add a new numbered file; never edit applied migrations. DDL is written idempotently (`IF NOT EXISTS` etc.). New tables need RLS policies using `is_account_member`.

### i18n
next-intl with a **single build-time locale** (`NEXT_PUBLIC_APP_LOCALE`: en/ko/pt/es/ar), not per-user routing. Catalogues are `messages/*.json`; `en.json` is the source of truth. Any new key must be added to every locale file — `src/i18n/messages.test.ts` enforces key parity and `icu-safety.test.ts` checks ICU syntax. The `@app-messages` alias (next.config.ts / vitest.config.ts) points at the active catalogue. Format dates/numbers with `INTL_LOCALE` / `DATE_FNS_LOCALE` from `src/lib/i18n/locale.ts`, not the browser default.

`ar` renders `dir="rtl"`: use logical Tailwind classes (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `text-start`, `border-s`, `rounded-s`) instead of left/right ones, give sideways `translate-x` explicit `ltr:`/`rtl:` variants, and add `rtl:rotate-180` to back/next arrow icons. The flow canvas and charts stay LTR on purpose.

### Config notes
`next.config.ts` sets security headers (CSP is report-only for now), `no-store` cache headers (works around Hostinger CDN caching stale HTML), `output: "standalone"` for Docker, and `agentRules: false` so `next dev` doesn't overwrite AGENTS.md.
