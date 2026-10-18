-- Per-claim render-job leases. Safe to run repeatedly on existing databases.
ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_render_jobs_active_heartbeat
  ON render_jobs(status, heartbeat_at)
  WHERE status IN ('CLAIMED', 'RUNNING');
