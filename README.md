# Creator Studio: a world of AI in one app

One account, one credit wallet, every kind of AI:

| | What users get |
|---|---|
| **Create** | Images, videos, music, 3D models, websites, apps and games from one prompt, with the credit cost shown before anything runs |
| **Write & code** | Streaming chat, stories, scenarios and scripts, coding help |
| **Research** | Answers grounded in live web search, with numbered citations |
| **Agents** | Describe an agent in one sentence; AI writes its instructions. Save, share publicly, chat |
| **Explore** | A searchable universe of premium and free models (OpenRouter's catalogue plus curated fal.ai image and video models) |
| **Developer API** | The same models and credits from their own apps, using API keys |

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

## Running it as the owner (no code needed)
Set three values once on the server: `OWNER_EMAIL` (your email), `OWNER_SETUP_CODE` (a private code only you know) and `SETTINGS_ENCRYPTION_KEY` (`openssl rand -hex 32`). Then sign up with your email, click **I'm the owner** and enter the code. Without the code nobody, including someone who knows your email, can claim the owner account. That account is the **only owner**. A database index allows exactly one owner, and the server re-applies `OWNER_EMAIL` at every start, so nobody else can take ownership. Then open **Owner dashboard**:
- **Setup:** a live launch checklist (models, payments, email, GST, storage, alerts) with a **Fix** button for each item.
- **API keys:** paste each provider key, with a link to where to get it. Keys are encrypted with AES-256-GCM, and only the last 4 characters are ever shown. Keys set in the server environment override dashboard keys and can't be changed here.
- **Settings:** changes go live on every server within seconds, with no redeploy.
  - plan prices, credits and limits; credit packs; markup, with a live per-plan margin preview; referral rewards;
  - sign-ups on or off; maintenance mode (customers see a holding page while you keep full access); a site-wide announcement banner; email verification and moderation switches;
  - business and GST details; Razorpay plan IDs;
  - automation: the daily report hour, and auto-disabling of loss-making models.
- **Staff (optional):** only you can make someone staff. Staff get support tools (Users, view Models) but never profit, settings, keys, roles, pricing or GST exports, and they can't touch your account.

**Automatic, every day:**
- a report by email (and Slack/Discord if connected) with yesterday's revenue, AI cost, profit, new users, failures and anything still missing from setup;
- a loss guard that alerts you, or optionally disables a model, when its real cost exceeded what users paid over the last 7 days;
- OpenRouter model sync, plan renewals and downgrades, refunds for failed or stuck jobs, and provider failover.

Email verification turns itself on only once email sending works, so new users are never locked out before you connect Resend.

## Model universe
- **Text, coding and agent models** come from OpenRouter. Its full model list is synced at startup and daily by the worker, or on demand from Admin > Models > Sync. Free models (`:free`, or zero price) cost **0 credits** and carry a note that their host may log prompts. Daily message caps per plan limit abuse.
- **Image and video models** come from fal.ai. Curated defaults are seeded once: FLUX schnell, dev and 1.1 pro; Kling 2.1 Master; Veo 3.1 and Veo 3.1 Fast. Their IDs and duration rules were checked against fal's model pages; **verify the prices** before launch.
- **Editing:** admins can add, feature, disable or re-price any model without a deploy. Duration snapping (for example Veo's 4/6/8 seconds) and extra inputs are configured per model.
- **Built-in providers** (OpenAI, Anthropic, Stability, Replicate, ElevenLabs) still work alongside the catalogue.

## Chat, story, code, research and agents
- **Streaming:** replies stream over Server-Sent Events: `POST /api/v1/chat/conversations/:id/messages`.
- **Credits:** each reply reserves its worst-case cost, then charges actual usage, using OpenRouter's reported cost when available. A failure before any text is fully refunded. If a balance can't cover a full-length reply, the reply is shortened to fit rather than refused.
- **Research and web-search agents:** the engine searches with Tavily or Brave, passes the numbered sources to the model, and returns citations. Each search adds `SEARCH_COST_USD`.
- **Agent generator:** turns one sentence into a validated agent spec (name, instructions, starter prompts, tools). If the first model fails, it falls back to the next.

## How you make money (owner income)
Payments go to **your** Razorpay account, and the owner dashboard is visible only to `ADMIN_EMAILS`. API keys can never reach admin endpoints.
1. **Subscriptions and credit packs.** Credits are priced at provider cost × `PRICE_MARKUP` (1.6×). Each credit costs you about ₹0.16 in provider fees (₹0.25 ÷ 1.6). Plans sell credits at ₹0.26–₹0.33 each, a 41–53% gross margin on credits that get used. Packs sell at ₹0.29–₹0.40 each, a 45–61% margin. Unused monthly credits expire, which adds margin.
2. **Free models as the funnel.** The free plan runs on free models that cost you nothing, so users can try the product at near-zero cost. Premium models, video and commercial rights sit behind paid plans.
3. **Developer API.** Sell the same credits to businesses and developers who call the models from their own code (Developer page, `Authorization: Bearer sk_live_…`).
4. **Referrals.** Inviters earn credits only after the invited person pays, so referral spend is always covered by revenue.
5. **Watching the numbers.** Admin > Profit shows revenue, provider cost (₹), gross profit and margin, MRR, ARPU, the cost of serving unspent credits, and margin per model family. Re-price or disable unprofitable models in Admin > Models.

Nothing here guarantees income: results depend on traffic and conversion. Your costs also include hosting, Razorpay's per-transaction fees (check the current rate), GST, and provider price changes.

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

## GST invoices
An invoice is issued inside the same database transaction that records each payment (credit packs and every subscription charge), so a paid order never lacks an invoice, and a payment reported twice gets one invoice.
- **Tax Invoice** when `SELLER_GSTIN` is set: CGST + SGST if the buyer is in your state (UTGST instead of SGST in union territories without a legislature); IGST across states. **Bill of Supply** without tax if you're not registered.
- **Place of supply**: the state of the buyer's GSTIN if they gave one; otherwise the state they selected; otherwise your state.
- **Prices** include GST by default (`PRICES_INCLUDE_GST`), so a ₹499 pack is ₹422.88 + ₹76.12 GST.
- **Numbers** are gap-free per financial year (April–March, IST), at most 16 characters, for example `INV2627-000001`.
- **Snapshots**: invoices can't be changed later. Seller and buyer details are copied at issue time, so later profile edits don't rewrite past invoices.
- **Buyers** can add a name, address, state and GSTIN under Billing. GSTINs are checked for format, check character, and a state that matches.
- **Viewing**: invoices open as printable HTML through a link that expires after 10 minutes; use "Save as PDF" to keep one.
- **Admins** can export a CSV for any date range to prepare GST returns (GSTR-1). Cells are protected against spreadsheet formula injection.
- **Startup checks**: the server refuses to start with an invalid `SELLER_GSTIN`, a state code that doesn't match it, or a GSTIN without `GST_SAC_CODE`. In production it also refuses to take payments without your legal name and address.

## Monitoring
All optional; each one is off until its variable is set.
- **Sentry** (`SENTRY_DSN`): unhandled API errors and worker failures. User info, cookies, headers, request bodies and query strings are never sent, since they can contain prompts, tokens and emails.
- **Alerts** (`ALERT_WEBHOOK_URL`, Slack or Discord): a provider's circuit breaker trips; jobs time out and are refunded; queued jobs wait more than 5 minutes; a Razorpay webhook fails. Each alert is sent at most once per 15 minutes.
- **Metrics** (`METRICS_TOKEN`): `GET /metrics` in Prometheus format, covering queue depth, jobs waiting on providers, the oldest queued job's age, credits on hold, and jobs and provider cost per provider over the last hour. Without the token the endpoint returns 404.
- Every response carries an `X-Request-Id`, which is also written to the request log and shown in 500 errors so support can find a failing request.

## Must verify before launch (not confirmed here)
- **fal.ai prices** in Admin > Models (seeded values are conservative estimates) and OpenRouter terms for the models you feature.
- **Prices**: the USD figures in each adapter are planning estimates. Check them against the current pricing pages for OpenAI, Anthropic, Stability, Replicate and ElevenLabs.
- **Model IDs and endpoints**: `OPENAI_CODE_MODEL` (default `gpt-4.1`), `ANTHROPIC_MODEL`, and especially the **ElevenLabs Music endpoint and parameters**, which could not be confirmed.
- **Replicate**: every model has its own input schema and licence. Match the input builders in `adapters/replicate.ts` to the models you choose, and set `REPLICATE_COMMERCIAL_LICENSE_CONFIRMED=true` only after reviewing each licence. Until then, paid (commercial-use) plans will not route to Replicate.
- **GST (with your CA)**: the SAC code (`GST_SAC_CODE`, required once you're registered), the rate, whether prices include GST, the invoice layout and the place-of-supply rules described above.
- **Razorpay**: create the 4 plans in the dashboard, put their IDs in `RAZORPAY_PLAN_IDS`, and subscribe the webhook to `payment.captured`, `subscription.*` and `order.paid`.

## Not included yet
Credit notes for refunds: refunds aren't automated yet, so issue credit notes manually for now. Government e-invoicing (IRN), which applies above an annual turnover threshold (₹5 crore when this was written; confirm with your CA).

## Tests
`npm test` runs 120 unit and API tests against a real Postgres. They cover intent detection, wallet invariants (including concurrent holds), fallback, refunds, idempotency, quote tampering, plan gates, refresh-token reuse, webhooks, admin actions, email verification, password reset, storage quotas, long-running jobs, alerts and metrics, GST invoices, the model catalogue and OpenRouter sync, fal.ai submit/poll, streaming chat billing (free, paid, refunds, low balances, daily caps), research citations, agents (generator, sharing, privacy), developer API keys, referrals, the profit dashboard, the single-owner model and staff limits, live settings, encrypted key storage, maintenance and sign-up switches, the setup checklist, the daily report and the loss guard.
