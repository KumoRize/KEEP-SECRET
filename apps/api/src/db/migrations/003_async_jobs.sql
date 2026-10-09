-- Long-running provider jobs (video, 3D, music) are submitted, then polled later,
-- so a worker slot is not held while the provider renders.
ALTER TABLE generations
  ADD COLUMN external_id     TEXT,          -- provider-side job id while waiting
  ADD COLUMN candidate_index INT NOT NULL DEFAULT 0,
  ADD COLUMN next_poll_at    TIMESTAMPTZ,
  ADD COLUMN poll_count      INT NOT NULL DEFAULT 0;

-- Waiting jobs are 'running' with no lock; workers pick them up when next_poll_at is due.
CREATE INDEX generations_poll_idx ON generations (next_poll_at) WHERE status = 'running' AND locked_at IS NULL;
