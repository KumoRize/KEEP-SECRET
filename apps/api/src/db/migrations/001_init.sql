CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan_id       TEXT NOT NULL DEFAULT 'free',
  plan_renews_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   UUID NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- Two buckets: subscription credits reset each cycle, purchased credits never expire.
CREATE TABLE wallets (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  subscription_balance BIGINT NOT NULL DEFAULT 0 CHECK (subscription_balance >= 0),
  purchased_balance  BIGINT NOT NULL DEFAULT 0 CHECK (purchased_balance >= 0),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL, -- grant_subscription | expire_subscription | purchase | hold | refund | capture | admin_adjust
  delta_subscription BIGINT NOT NULL DEFAULT 0,
  delta_purchased BIGINT NOT NULL DEFAULT 0,
  balance_after   BIGINT NOT NULL,
  ref_type        TEXT,
  ref_id          TEXT,
  idempotency_key TEXT UNIQUE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC);

CREATE TABLE projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_user_idx ON projects (user_id, created_at DESC);

CREATE TABLE generations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
  prompt            TEXT NOT NULL,
  modality          TEXT NOT NULL,
  params            JSONB NOT NULL DEFAULT '{}',
  candidates        JSONB NOT NULL DEFAULT '[]', -- ordered [{providerId, model, credits}]
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  held_credits      BIGINT NOT NULL,
  hold_subscription BIGINT NOT NULL DEFAULT 0,
  hold_purchased    BIGINT NOT NULL DEFAULT 0,
  charged_credits   BIGINT,
  provider_id       TEXT,
  model             TEXT,
  provider_cost_usd_micros BIGINT,
  attempts          JSONB NOT NULL DEFAULT '[]',
  license_note      TEXT,
  error             TEXT,
  idempotency_key   TEXT NOT NULL,
  locked_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX generations_queue_idx ON generations (created_at) WHERE status = 'queued';
CREATE INDEX generations_user_idx ON generations (user_id, created_at DESC);
CREATE INDEX generations_running_idx ON generations (locked_at) WHERE status = 'running';

CREATE TABLE assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assets_generation_idx ON assets (generation_id);

CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('credit_pack', 'subscription')),
  item_id            TEXT NOT NULL,
  amount_paise       BIGINT NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'INR',
  status             TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
  razorpay_order_id  TEXT UNIQUE,
  razorpay_payment_id TEXT UNIQUE,
  razorpay_subscription_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ
);

CREATE TABLE subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                  TEXT NOT NULL,
  razorpay_subscription_id TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'created',
  current_period_end       TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  event       TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE provider_settings (
  provider_id TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  priority    INT NOT NULL DEFAULT 100,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID,
  action     TEXT NOT NULL,
  target     TEXT,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
