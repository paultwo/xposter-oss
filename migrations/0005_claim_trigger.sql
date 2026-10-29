-- The local D1 SQLite rejects UPDATE inside a WITH clause, so the attempt
-- row is inserted by a trigger on the claim UPDATE. The trigger runs in that
-- same statement: zero matching rows means no attempt, and a failed insert
-- rolls the claim back.

CREATE TRIGGER items_claim_attempt
AFTER UPDATE OF lease_id ON items
WHEN NEW.status = 'posting'
  AND OLD.status = 'scheduled'
  AND NEW.lease_id IS NOT NULL
  AND OLD.lease_id IS NULL
  AND NEW.resend_segment_id IS NOT NULL
BEGIN
  INSERT INTO post_attempts (
    id, segment_id, item_id, lease_id, started_at, outcome, resolved_at
  ) VALUES (
    NEW.lease_id,
    NEW.resend_segment_id,
    NEW.id,
    NEW.lease_id,
    NEW.updated_at,
    NULL,
    NULL
  );
END;
