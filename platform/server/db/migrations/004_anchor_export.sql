-- 004: F-16 residual — remember how far the chain head has been exported to the external append-only
-- anchor log (<data>/audit-anchor.log). /audit/verify fails if that log is missing or behind this point.
ALTER TABLE audit_anchor ADD COLUMN exported_id INTEGER;
ALTER TABLE audit_anchor ADD COLUMN exported_hash TEXT;
