-- CHANGEOVER 0002 — the access log. SPEC.md §5.4, rules P1–P3 and A1–A4.
--
-- Owner: CORE-001. The writer is @changeover/core/access-log.ts (CORE-007).
--
-- Every invocation — ok, refused, error — writes one row. Refusals are logged
-- deliberately: a log with only successes cannot show someone probing the
-- boundary, which is the thing you most want to see.
--
-- What is NOT here is the design:
--   * no request parameters. The draft stored them, and a competent agent's
--     work_hint was "The Conversation, 35mm, wheelchair space for my mother
--     Ruth, sarah.chen@gmail.com has the booking." That is not an adversarial
--     scenario; it is Tuesday.
--   * no raw work_hint, no raw intent_digest, no raw Idempotency-Key. P2: only
--     HMAC-SHA256(site_epoch_key, value), and the key rotates on a published
--     interval and the retired key is destroyed. Crypto-shredding is how an
--     append-only store honours erasure without a DELETE.
--   * no claim token, ever (CL5). The Server logs the FACT of hand-off.
--   * no seat ids, no free prose, no body of any kind (A4: refusals are logged
--     at bounded size — code, verb, agent_id, slot). Every column below is
--     bounded by a CHECK or by its type.
--   * no name, email, phone, loyalty number or payment instrument. There is no
--     column one could be written into.
--
-- A1 asks for storage independent of the hold store, so that exhaustion of one
-- cannot deny writes to the other. Within one database the strongest available
-- form is a separate schema under separate ownership, which is what this is; a
-- conforming deployment puts changeover_log on its own tablespace or its own
-- cluster. That last step is a deployment property this migration cannot assert
-- and does not pretend to — see the note in packages/store/README.md.

create schema changeover_log;

create table changeover_log.access_log (
  log_id               bigint generated always as identity,

  -- A3: the log is partitioned by local_wall DATE. The partition key is a plain
  -- column rather than a generated one because casting text to date is STABLE,
  -- not IMMUTABLE, and a partition key must be immutable. The CHECK below binds
  -- it to local_wall so the two cannot drift.
  local_wall_date      date not null,

  -- §2.2: local_wall is load-bearing and it has a fold. Any slot or daypart
  -- derived downstream MUST derive from local_wall, never UTC — UTC migrates a
  -- site's whole Sunday-morning cohort into Saturday night once a year and
  -- nobody notices for a decade. Cinemas run marathons through 2am on the first
  -- Sunday in April; without the offset two sessions collide on one natural key
  -- and the log drops one.
  local_wall           text not null check (local_wall ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  local_wall_offset    text not null check (local_wall_offset ~ '^[+-]\d{2}:\d{2}$'),

  -- The measurement grain, derived in the database from local_wall so that no
  -- writer can supply a UTC-derived one by accident. Hour of local wall day.
  local_wall_slot      integer generated always as ((substring(local_wall from 12 for 2))::integer) stored,

  -- K4: one time source. Server-side, always; no request carries a client
  -- timestamp, so there is none to record.
  observed_at          timestamptz not null,

  agent_id             text not null check (agent_id ~ '^agt_[A-Za-z0-9_-]{1,40}$'),
  principal_scope      text not null check (length(principal_scope) between 1 and 255),

  verb                 text not null check (verb in
                         ('resolve_occasions', 'hold_seats', 'get_hold',
                          'release_hold', 'hand_off',
                          'claim_render', 'claim_confirm')),
  outcome              text not null check (outcome in ('ok', 'refused', 'error')),
  refusal_code         text check (refusal_code is null or length(refusal_code) <= 64),

  -- Server-minted and non-personal. The token that reaches the customer is not
  -- here and never will be (CL5).
  hold_id              text check (hold_id is null or hold_id ~ '^hold_[0-9A-HJKMNP-TV-Z]{32}$'),
  occasion_id          text check (occasion_id is null or length(occasion_id) <= 128),

  -- P2. Base64url of HMAC-SHA256(site_epoch_key, value); 43 characters. The
  -- epoch id says which key, so a rotation is representable and a destroyed key
  -- makes its rows unlinkable rather than requiring a DELETE the grants forbid.
  site_epoch_id        text not null check (length(site_epoch_id) between 1 and 64),
  work_hint_hmac       text check (work_hint_hmac       is null or work_hint_hmac       ~ '^[A-Za-z0-9_-]{43}$'),
  intent_digest_hmac   text check (intent_digest_hmac   is null or intent_digest_hmac   ~ '^[A-Za-z0-9_-]{43}$'),
  idempotency_key_hmac text check (idempotency_key_hmac is null or idempotency_key_hmac ~ '^[A-Za-z0-9_-]{43}$'),

  -- §5.4's four measurement failure modes, designed in from the first migration
  -- because a series cannot be back-filled. Idempotent ingest on
  -- (record_source, natural_key) INCLUDING local_wall_offset; append-only
  -- records versioned on input_watermark.
  record_source        text not null check (length(record_source) between 1 and 64),
  natural_key          text not null check (length(natural_key) between 1 and 128),
  input_watermark      timestamptz not null,

  -- A2: fail-closed applies to WRITE verbs. For reads a Server MAY degrade to a
  -- durable secondary sink and MUST record the degradation as an event. An
  -- unbounded fail-closed log is otherwise an availability weapon: fill it with
  -- refused calls and release_hold fails too, so seats stay held while the
  -- boundary is dark.
  degraded             boolean not null default false,

  primary key (local_wall_date, log_id),

  -- §5.4: "A CHECK MUST force a reason on refusals." The reason is the closed
  -- refusal code; A4 says code, verb, agent_id, slot and nothing else, so the
  -- code is the whole reason and there is no prose column for a second one.
  constraint access_log_refusal_has_reason
    check ((outcome = 'refused') = (refusal_code is not null)),
  constraint access_log_partition_key_matches_wall
    check (local_wall_date = (substring(local_wall from 1 for 10))::date),
  constraint access_log_ingest
    unique (local_wall_date, record_source, natural_key, local_wall_offset)
) partition by range (local_wall_date);

-- A row must always have somewhere to land: A2 makes the log fail-closed for
-- write verbs, so a missing partition would deny hold_seats and release_hold
-- alike. Month partitions are created ahead of time by ensureLogPartitions()
-- in migrate.ts; this one catches everything else.
create table changeover_log.access_log_default
  partition of changeover_log.access_log default;

create index access_log_agent_idx on changeover_log.access_log (agent_id, local_wall_date);
create index access_log_slot_idx  on changeover_log.access_log (local_wall_date, local_wall_slot);
create index access_log_refusal_idx on changeover_log.access_log (refusal_code, local_wall_date)
  where outcome = 'refused';
