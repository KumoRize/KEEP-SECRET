-- Admin-editable catalog of every model the app can route to. Text models can be synced from
-- OpenRouter; media models (fal.ai etc.) are curated. Prices are provider cost in USD.
CREATE TABLE catalog_models (
  id              TEXT PRIMARY KEY,            -- '<provider>:<provider model id>'
  provider_id     TEXT NOT NULL,
  model           TEXT NOT NULL,
  categories      TEXT[] NOT NULL CHECK (cardinality(categories) > 0 AND categories <@ ARRAY['image','video','3d','music','website','app','game','chat','story','code','research']),
  label           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  is_free         BOOLEAN NOT NULL DEFAULT false,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  featured        BOOLEAN NOT NULL DEFAULT false,
  quality         INT NOT NULL DEFAULT 5 CHECK (quality BETWEEN 1 AND 10),
  -- text: {"inputPerMTok": 3, "outputPerMTok": 15}; image: {"perImage": 0.03}; video/music: {"perSecond": 0.1}
  pricing         JSONB NOT NULL DEFAULT '{}',
  -- How to shape the provider request, e.g. {"sizeParam":"image_size","durationFormat":"string","allowedDurations":[5,10],"extra":{}}
  input_options   JSONB NOT NULL DEFAULT '{}',
  context_length  INT,
  max_duration_sec INT,
  commercial_use  BOOLEAN NOT NULL DEFAULT true,
  license_note    TEXT NOT NULL DEFAULT '',
  data_note       TEXT NOT NULL DEFAULT '',  -- e.g. free models whose hosts may log prompts
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('default','sync','manual')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX catalog_models_categories_idx ON catalog_models USING gin (categories);

CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  instructions    TEXT NOT NULL,
  model_id        TEXT,                         -- catalog id; NULL = pick the best available chat model
  tools           TEXT[] NOT NULL DEFAULT '{}', -- currently: 'web_search'
  starter_prompts TEXT[] NOT NULL DEFAULT '{}',
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  uses            INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agents_owner_idx ON agents (owner_id, updated_at DESC);
CREATE INDEX agents_public_idx ON agents (uses DESC) WHERE visibility = 'public';

CREATE TABLE conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL CHECK (mode IN ('chat','story','code','research','agent')),
  agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  model_id   TEXT,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  citations       JSONB NOT NULL DEFAULT '[]',  -- [{n, title, url}]
  model_id        TEXT,
  generation_id   UUID REFERENCES generations(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id);

-- Developer API keys: only a SHA-256 hash is stored; the full key is shown once.
CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,         -- first characters, for display
  key_hash     TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- Referrals: rewards are paid only after the referred user's first real payment.
ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE, ADD COLUMN referred_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE users SET referral_code = upper(substr(md5(id::text || random()::text), 1, 8)) WHERE referral_code IS NULL;
CREATE TABLE referral_rewards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_id  UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, -- one reward per referred user
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  referrer_credits INT NOT NULL,
  referee_credits  INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
