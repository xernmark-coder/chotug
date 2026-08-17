-- ===========================================================================
--  09 — USER INVITES
--
--  An owner adds a person by email and picks their role. The person is created
--  with status INVITED and no password, and receives a one-time link that lets
--  them set their own password. Nobody ever types a password on someone else's
--  behalf, so there is no shared secret to leak or to change later.
--
--  Idempotent, like every file in this directory.
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_invites (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Only the SHA-256 of the token is stored. A leaked database row cannot be
    -- turned back into a working invite link.
    token_hash  text NOT NULL UNIQUE,

    expires_at  timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid
);

CREATE INDEX IF NOT EXISTS ix_user_invites_user ON user_invites (user_id);

-- Deliberately no company_id and no row-level security. The row holds no
-- tenant data — it is a pointer to one user plus a hash — and it must be
-- readable by the accept-invite endpoint, which by definition runs before
-- anyone has authenticated and so has no company context to filter on. The
-- token itself is the capability; tenancy is enforced on the user it names.

COMMIT;
