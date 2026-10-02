ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
-- Accounts created before verification existed keep working; only new sign-ups must verify.
UPDATE users SET email_verified_at = created_at;

CREATE TABLE auth_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, kind);
