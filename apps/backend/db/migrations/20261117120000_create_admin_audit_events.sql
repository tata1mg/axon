-- migrate:up
-- Append-only record of who did what in the dashboard, including sign-in attempts.
CREATE TABLE "META_HARNESS_admin_audit_events" (
    id BIGINT GENERATED ALWAYS AS IDENTITY CONSTRAINT "META_HARNESS_admin_audit_events_pkey" PRIMARY KEY,
    actor_user_id BIGINT NOT NULL,
    actor_email VARCHAR(320) NOT NULL,
    -- Role at the time of the action; NULL for a denied sign-in by a non-member.
    actor_role VARCHAR(32),
    action VARCHAR(128) NOT NULL,
    target_type VARCHAR(64),
    target_id VARCHAR(256),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "META_HARNESS_admin_audit_events_action" CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    CONSTRAINT "META_HARNESS_admin_audit_events_target" CHECK (
        (target_type IS NULL AND target_id IS NULL) OR (length(target_type) > 0 AND target_id IS NOT NULL)
    ),
    CONSTRAINT "META_HARNESS_admin_audit_events_details" CHECK (
        jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 16384
    )
);
CREATE INDEX "META_HARNESS_admin_audit_events_actor" ON "META_HARNESS_admin_audit_events" (actor_user_id, id DESC);

-- migrate:down
DROP TABLE "META_HARNESS_admin_audit_events";
