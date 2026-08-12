-- Indexed admin lookups for V2 submission provenance and canonical results.
CREATE INDEX IF NOT EXISTS idx_agent_submissions_result_event
  ON agent_submissions(result_event_id, last_received_at);

CREATE INDEX IF NOT EXISTS idx_agent_submissions_last_received
  ON agent_submissions(last_received_at, id);

CREATE INDEX IF NOT EXISTS idx_events_title
  ON events(title);
