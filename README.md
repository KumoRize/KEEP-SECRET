# Creator Studio: an all-in-one AI creator SaaS

Users type one prompt. The orchestrator works out what they want (image, video, 3D model, website, app, game or music), picks a provider and model, and shows the credit cost **before** anything runs. Credits are held when a job starts. They are charged for the actual cost when it succeeds and refunded automatically when it fails.

## Stack
| Layer | Choice |
|---|---|
| API and worker | Node 22, TypeScript, Express 5, zod |
| Data | PostgreSQL 16 (also serves as the job queue via `SKIP LOCKED`), Redis for rate limits (falls back to in-memory) |
| Files | S3-compatible storage (S3, R2, MinIO) or local disk with signed, expiring URLs |
| Payments | Razorpay (INR): Orders for credit packs, Subscriptions for plans, HMAC-verified webhooks |
| Web | React 19 + Vite, mobile-first, dark mode, served by the API in production |

## Quick start
```bash
cp .env.example .env              # fill the three secrets; to try it locally set ENABLE_MOCK_PROVIDER=true and MAIL_DRIVER=console (links appear in the API log)
docker compose up --build         # api on :8080 plus worker, Postgres and Redis
# or run it locally:
npm ci && npm run migrate && npm run dev:api   # and: npm run dev:web, npm run worker -w apps/api
```
Emails listed in `ADMIN_EMAILS` become admins when they register.

## How a generation flows
1. `POST /api/v1/generations/estimate {prompt}` → intent detection (`orchestrator/intent.ts`) → plan checks → candidate models ranked by admin priority, then quality or cost (`router.ts`). The response is an HMAC-signed quote that binds the user, a hash of the prompt, the price and the fallback chain, and expires after 10 minutes.
2. `POST /api/v1/generations` with an `Idempotency-Key` header. In one transaction it checks the concurrency and daily limits, inserts the job and holds `max(credits across fallbacks)`.
3. The worker tries each candidate in order. Fast models (images, code) run to completion. Long-running models (video, 3D and music on Replicate) are **submitted and released**: the job holds no worker while the provider renders, and a worker checks on it again when it's due (5s, backing off to 30s). A few video users can't block everyone else's images. Outages (429, 5xx, timeouts) fall through to the next provider and count towards a circuit breaker. **A content or policy refusal is final and never routed to another provider.**
4. On success the files are stored, the actual cost is charged (capped at the hold) and the rest is refunded. On failure, a timeout (reaper) or a user cancel, everything is refunded. Settlement is guarded by a status transition, so it happens exactly once.

## Plans (₹/month, editable in `billing/plans.ts`)
| Plan | Price | Credits | Types | Video | Commercial use |
|---|---|---|---|---|---|
| Free | ₹0 | 60 | image, website, music | – | no |
| Starter | ₹199 | 600 | all 7 | 5s | yes |
| Creator | ₹499 | 1,700 | all 7 | 10s | yes |
| Pro | ₹999 | 3,600 | all 7 | 10s | yes |
| Studio | ₹1,999 | 7,600 | all 7 | 10s | yes |

Each plan's storage limit is enforced: once a user's files reach it, new generations are refused until they delete files or upgrade.

Credit packs (₹199/500, ₹499/1,500, ₹999/3,500) never expire. Subscription credits reset each billing cycle and are spent first. Price formula: `credits = ceil(usd × USD_INR × PRICE_MARKUP / INR_PER_CREDIT_COST)`, for example a $0.05 image costs 27 credits.

## Adding a provider
Write a `ProviderAdapter` in `apps/api/src/modules/providers/adapters/` (fill in `models()` with a cost estimator and licence metadata, `run()` returns files and the optional actual cost) and add it in `registry.ts`. Routing, pricing, fallback, credit handling and the admin page pick it up with no other changes.

## Security
- Provider keys are read only from server environment variables. The admin API reports whether a key is set, never the key itself, and logs redact secrets.
- New accounts must verify their email before generating (`REQUIRE_EMAIL_VERIFICATION`), which stops people farming free credits with throwaway addresses. Verification and password-reset links are single-use, stored only as hashes, and expire after 24 hours and 1 hour respectively. Requesting a reset gives the same response whether or not the account exists, and a completed reset signs out every session. Email goes through the Resend API; set `MAIL_DRIVER=console` to log messages instead during development.
- Passwords use scrypt. Access JWTs last 15 minutes and are kept in memory on the client. Refresh tokens are httpOnly, SameSite=Strict cookies that rotate on each use; reusing an old one revokes the whole token family.
- Rate limits: 300 requests/min per IP overall, 10/min on auth, 20 generations/min per user, on top of the per-plan concurrency and daily caps.
- Generated HTML is served under `CSP: sandbox` (an opaque origin) and shown in sandboxed iframes. File paths from code generation are checked to block path traversal.
- Prompts are screened with OpenAI's moderation endpoint when an OpenAI key is set.
- Razorpay signatures are checked with constant-time comparison. Webhooks are deduplicated by event ID, and credits are granted idempotently.

## Monitoring
All optional; each one is off until its variable is set.
- **Sentry** (`SENTRY_DSN`): unhandled API errors and worker failures. User info, cookies, headers, request bodies and query strings are never sent, since they can contain prompts, tokens and emails.
- **Alerts** (`ALERT_WEBHOOK_URL`, Slack or Discord): a provider's circuit breaker trips; jobs time out and are refunded; queued jobs wait more than 5 minutes; a Razorpay webhook fails. Each alert is sent at most once per 15 minutes.
- **Metrics** (`METRICS_TOKEN`): `GET /metrics` in Prometheus format, covering queue depth, jobs waiting on providers, the oldest queued job's age, credits on hold, and jobs and provider cost per provider over the last hour. Without the token the endpoint returns 404.
- Every response carries an `X-Request-Id`, which is also written to the request log and shown in 500 errors so support can find a failing request.

## Must verify before launch (not confirmed here)
- **Prices**: the USD figures in each adapter are planning estimates. Check them against the current pricing pages for OpenAI, Anthropic, Stability, Replicate and ElevenLabs.
- **Model IDs and endpoints**: `OPENAI_CODE_MODEL` (default `gpt-4.1`), `ANTHROPIC_MODEL`, and especially the **ElevenLabs Music endpoint and parameters**, which could not be confirmed.
- **Replicate**: every model has its own input schema and licence. Match the input builders in `adapters/replicate.ts` to the models you choose, and set `REPLICATE_COMMERCIAL_LICENSE_CONFIRMED=true` only after reviewing each licence. Until then, paid (commercial-use) plans will not route to Replicate.
- **Razorpay**: create the 4 plans in the dashboard, put their IDs in `RAZORPAY_PLAN_IDS`, and subscribe the webhook to `payment.captured`, `subscription.*` and `order.paid`.

## Not included yet
GST invoices.

## Tests
`npm test` runs 57 unit and API tests against a real Postgres. They cover intent detection, wallet invariants (including concurrent holds), fallback, refunds, idempotency, quote tampering, plan gates, refresh-token reuse, webhooks, admin actions, email verification, password reset and storage quotas.
