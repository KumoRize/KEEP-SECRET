-- A single platform owner. Staff admins can be added by the owner only.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'owner'));
CREATE UNIQUE INDEX users_single_owner ON users ((true)) WHERE role = 'owner';

-- Owner-editable runtime settings (pricing, plans, toggles). Applied live without a redeploy.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Provider API keys entered in the dashboard, encrypted with AES-256-GCM (SETTINGS_ENCRYPTION_KEY).
-- Plaintext never leaves the server; the dashboard only sees the last 4 characters.
CREATE TABLE app_secrets (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  last4      TEXT NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
