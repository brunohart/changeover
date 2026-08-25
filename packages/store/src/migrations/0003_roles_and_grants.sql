-- CHANGEOVER 0003 — roles and grants. The boundary, as the database sees it.
--
-- Owner: CORE-001.
--
-- Everything here exists so that a rule an agent must not break is a rule it
-- CANNOT break, rather than one it is asked not to. Three properties are made
-- structural, and scripts/prove_migrations.sh attempts each of them under
-- SET LOCAL ROLE and asserts the 42501:
--
--   1. The access log is APPEND-ONLY BY GRANT (A3). changeover_agent holds
--      INSERT and SELECT and nothing else on it. UPDATE and DELETE are not
--      withheld by convention, by a trigger, or by a code path nobody calls;
--      they are absent from the grant, so they raise 42501 permission denied.
--      Erasure is honoured by destroying the site epoch key (P2) and by
--      detaching the partition (A3), never by rewriting a row.
--
--   2. The DROP capability lives in changeover_retention, which holds NOTHING
--      ELSE (A3). It owns the log and its partitions, so it can detach and drop
--      them; it has no privilege of any kind on the hold store, so the role
--      that can destroy the record of the boundary cannot operate the boundary.
--
--   3. A Hold's floor is immovable BY GRANT (T1, T3). changeover_agent's UPDATE
--      on `hold` is column-level and does not include granted_at, floor_ms,
--      floor_deadline, seats, hold_id or any credential column. There is no
--      extend verb, and there is also no UPDATE statement that would implement
--      one. And there is no DELETE on `hold` at all: M2 requires a Hold to
--      report its seats as granted for the life of the record, so the boundary
--      cannot end that life.
--
-- Both roles are NOLOGIN. They are privilege sets, entered with SET ROLE by an
-- application login role that is a member of them. On a deployment where the
-- migrating user cannot CREATE ROLE, run migrate(db, { withRoles: false }) and
-- provision these two roles and their grants out of band — the migration fails
-- loudly rather than degrading quietly, because a boundary whose grants
-- silently did not apply is worse than one that never claimed to have them.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'changeover_agent') then
    create role changeover_agent nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'changeover_retention') then
    create role changeover_retention nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The estate is read-only to the boundary.
--
-- W3: availability MUST be verified against the exhibitor's system of record.
-- The agent role can read that record and cannot write it, so the boundary
-- cannot mark a seat sold, cannot withdraw an Occasion, and cannot manufacture
-- the availability it then reports. A seat unavailable for a reason other than
-- a CHANGEOVER Hold is the exhibitor's fact, not the boundary's.
-- ---------------------------------------------------------------------------

grant select on occasion      to changeover_agent;
grant select on occasion_seat to changeover_agent;

-- ---------------------------------------------------------------------------
-- The hold store.
-- ---------------------------------------------------------------------------

grant select, insert on hold to changeover_agent;
grant update (
  -- T7/T2: expires_at is a movable merchant intention, upward only.
  expires_at,
  -- T5: the one event that may extend a seat's held-until, at most once.
  handed_off_at, handoff_floor_ms, claim_expires_at,
  -- The terminal markers of M1.
  released_at, claimed_at, revoked_at, revocation_reason,
  -- T4: the read_token get_hold mints and hand_off consumes.
  read_token_hmac, read_token_at
) on hold to changeover_agent;
-- Deliberately absent from both grants: DELETE, and UPDATE on hold_id,
-- agent_id, principal_scope, origin, cluster, occasion_id, occasion_etag,
-- sought_occasion_id, showtime_id, seats, granted_at, floor_ms, floor_deadline.

-- The reap deletes seat rows in the next contending transaction (ADR-006), so
-- the agent role holds DELETE here — and only here, and on the two other
-- occupancy tables.
grant select, insert, delete on hold_seat to changeover_agent;
grant update (state, held_until) on hold_seat to changeover_agent;

grant select, insert, delete on hold_cluster to changeover_agent;
grant update (state, held_until) on hold_cluster to changeover_agent;

grant select, insert, delete on hold_slot to changeover_agent;

grant select, insert, delete on idempotency to changeover_agent;
grant update (status, record, hold_id, retention_until) on idempotency to changeover_agent;

-- ---------------------------------------------------------------------------
-- The access log. A1's separation, A3's append-only.
-- ---------------------------------------------------------------------------

grant usage on schema changeover_log to changeover_agent;
-- INSERT and SELECT. That is the whole grant, and the whole point.
grant insert, select on changeover_log.access_log to changeover_agent;

-- The retention role owns the log, so DETACH PARTITION and DROP TABLE are
-- available to it and to nothing else. CREATE lets it build the rollup that
-- replaces a detached partition, carrying no agent_id, no principal_scope, no
-- digest and no seat ids.
grant usage, create on schema changeover_log to changeover_retention;
alter table changeover_log.access_log         owner to changeover_retention;
alter table changeover_log.access_log_default owner to changeover_retention;

-- ---------------------------------------------------------------------------
-- "Holding nothing else" is the property that makes the separation worth
-- having, so it is said out loud rather than left to a default that a later
-- migration could change without anyone noticing.
--
-- Postgres 15+ already revokes CREATE on schema public from PUBLIC but leaves
-- USAGE, which would give changeover_retention a reachable path to the hold
-- store the moment anything granted it a table privilege. Closing USAGE and
-- re-opening it to exactly one role means the retention role cannot so much as
-- name a hold table: it fails at the schema, before any table grant is
-- consulted.
-- ---------------------------------------------------------------------------

revoke all on occasion, occasion_seat, hold, hold_seat, hold_cluster, hold_slot, idempotency
  from changeover_retention;
revoke all on schema public from public;
grant usage on schema public to changeover_agent;
