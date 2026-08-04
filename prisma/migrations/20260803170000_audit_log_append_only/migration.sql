-- Make the audit log genuinely append-only.
--
-- SECURITY.md and AML_POLICY.md present this table as immutable evidence for
-- regulator queries, but it was an ordinary table owned by the application role:
-- anyone with DATABASE_URL (which sat in git history unrotated) could UPDATE or
-- DELETE rows — i.e. an attacker who moved money could erase the trail.
--
-- A trigger is used rather than REVOKE because the app connects as the table
-- owner on Render; ownership privileges would bypass a REVOKE, but a trigger
-- fires regardless of who performs the write.
--
-- Deliberate escape hatch: retention. AML/CBN requires ~5 years, after which
-- purging is legitimate. A session sets `audit.allow_purge = 'on'` to delete,
-- so routine application code can never do it by accident.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AuditLog is append-only: UPDATE is not permitted';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting('audit.allow_purge', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'AuditLog is append-only: DELETE requires the retention-purge flag';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutate ON "AuditLog";
CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
