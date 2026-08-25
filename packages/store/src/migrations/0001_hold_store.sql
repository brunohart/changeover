-- CHANGEOVER 0001 — the hold store.
--
-- Owner: CORE-001. Every constraint here is a normative rule made structural.
-- Where a rule could be enforced either in application logic or in the schema,
-- it is enforced in the schema, because "checks before writing is a race with
-- extra steps" (ADR-005) and because a thing an agent must not do should not be
-- asked not to do.
--
-- Two absences are load-bearing and are asserted by scripts/prove_migrations.sh:
--   1. `hold` has NO `state` column (M1–M3, SPEC.md:397–399). State is derived
--      at every read from timestamps and terminal markers, so a Hold past its
--      expiry reports `expired` with no reaper having run (ADR-006).
--   2. Nothing here names a person. No name, email, phone, loyalty number or
--      payment instrument, and no token standing for one (SPEC.md §2.6).
--
-- And one absence by construction: there is no settlement. No column records
-- an authorisation, a capture, a refund or a price paid (ADR-001).

-- ---------------------------------------------------------------------------
-- The estate. The reference implementation's own system of record for Profile 1
-- (`hold_basis: system_of_record`). W1 requires seat ids to be validated against
-- the auditorium's own inventory INSIDE the hold transaction; W3 requires
-- availability to be read from the exhibitor's system of record and not from
-- `hold_seat`. For Profile 1 those are these two tables. For Profile 1S
-- (ADR-008) they are a shim above a CMS and an adapter answers instead.
-- ---------------------------------------------------------------------------

create table occasion (
  occasion_id       text primary key,
  revision          integer not null check (revision >= 1),
  -- The etag over PROJECTION_0_1. `1:` plus 43 base64url characters (§2.4).
  etag              text not null check (etag ~ '^1:[A-Za-z0-9_-]{43}$'),

  -- venue.origin, as an O1 bare origin: (scheme, host, port), ASCII-lowercased,
  -- default ports normalised. The cluster fan-out key is (origin, cluster), so
  -- this column is part of an exhaustion guard, not decoration.
  origin            text not null check (origin ~ '^https?://[a-z0-9.:_-]+$'),

  -- showtime_ref.source and showtime_ref.showtime_id (§2.2). `showtime_ref` is
  -- OPTIONAL on the wire and absent from all three golden fixtures, so where a
  -- publisher omits it the reference implementation sets showtime_id =
  -- occasion_id. See the note on the seat-occupancy index below: that identity
  -- is what makes SPEC.md:366 and DECISIONS.md ADR-005 name the same index.
  source            text not null,
  showtime_id       text not null,

  -- The substitution cluster this Occasion sits in (X2). NULL means the
  -- Occasion is in no cluster and takes no cluster slot.
  cluster           text check (cluster is null or length(cluster) <= 128),

  seating           text not null check (seating in ('allocated', 'unallocated', 'unknown')),
  capacity          integer not null check (capacity > 0),   -- auditorium.capacity, read by X4
  availability_mode text not null check (availability_mode in ('seat_map', 'count', 'unknown')),

  starts_at         timestamptz not null,
  local_wall        text not null check (local_wall ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  local_wall_offset text not null check (local_wall_offset ~ '^[+-]\d{2}:\d{2}$'),
  sales_cutoff_at   timestamptz,                             -- G1 step 6

  withdrawn         boolean not null default false,

  -- The Occasion exactly as published. Read-side only; nothing in the hold path
  -- branches on it. It carries no personal data because its schema forbids one.
  document          jsonb
);

create index occasion_showtime_idx on occasion (showtime_id);
create index occasion_cluster_idx  on occasion (origin, cluster) where cluster is not null;

create table occasion_seat (
  occasion_id     text not null references occasion (occasion_id) on delete cascade,
  seat_id         text not null check (length(seat_id) between 1 and 64),
  section         text,
  seat_row        text,
  seat_number     integer,
  -- The exhibitor's own status, from §2.10. A seat unavailable for a reason
  -- other than a CHANGEOVER Hold — sold, blocked, house seat, accessibility
  -- hold — is 409 seat_unavailable (W3), and that is decided here, not in
  -- hold_seat.
  status          text not null check (status in
                    ('available', 'held', 'sold', 'blocked', 'companion', 'wheelchair')),
  adjacency_group text,
  primary key (occasion_id, seat_id)
);

-- ---------------------------------------------------------------------------
-- The Hold. §2.6, and the state machine of §4.9.
--
-- There is no `state` column and there must never be one. M1 derives state at
-- every read: `revoked` if an override is recorded; `released` if a release is;
-- `claimed` if a claim is; `handed_off` if handed off and server_time <
-- claim_expires_at; `live` if server_time < expires_at; else `expired`. Every
-- input to that function is a column here, and the function itself lives in
-- @changeover/core/derived.ts (CORE-003) so that it is written once.
-- ---------------------------------------------------------------------------

create table hold (
  -- Z2: >=160 bits from a CSPRNG. Crockford base32, I/L/O/U excluded. ULID and
  -- UUIDv7 are NOT acceptable generators: both leak and order by time.
  hold_id            text primary key check (hold_id ~ '^hold_[0-9A-HJKMNP-TV-Z]{32}$'),

  -- Credential-derived, both of them, and never read from a body (I2, X0).
  agent_id           text not null check (agent_id ~ '^agt_[A-Za-z0-9_-]{1,40}$'),
  principal_scope    text not null check (length(principal_scope) between 1 and 255),

  origin             text not null,
  cluster            text check (cluster is null or length(cluster) <= 128),

  occasion_id        text not null references occasion (occasion_id),
  occasion_etag      text not null check (occasion_etag ~ '^1:[A-Za-z0-9_-]{43}$'),
  -- S4: agent-asserted and unverifiable. Its value is that a misreport is a
  -- false statement recorded against a revocable credential.
  sought_occasion_id text not null,
  showtime_id        text not null,

  -- M2: the seats AS GRANTED, for the life of the record, in every state.
  -- `seats` is the grant, not current occupancy — otherwise `minItems: 1` has
  -- no legal value after a reap. Current occupancy is hold_seat.
  seats              text[] not null
                       check (cardinality(seats) between 1 and 12
                              and array_position(seats, null) is null),

  -- K4/§4.6: granted_at is clock_timestamp() at the instant the insert
  -- succeeds, NOT transaction start. A transaction that spent 600ms in lock
  -- waits otherwise mints a floor already 600ms in the past, and the deficit
  -- falls entirely on the agent's side where C-FLOOR can never see it.
  granted_at         timestamptz not null,
  floor_ms           integer not null check (floor_ms >= 1000),
  floor_deadline     timestamptz not null,
  expires_at         timestamptz not null,

  -- Hand-off (T5, CL4). At most once per Hold: handed_off_at is set once and
  -- the column-level UPDATE grants in 0003 do not let it be cleared.
  handed_off_at      timestamptz,
  handoff_floor_ms   integer check (handoff_floor_ms is null or handoff_floor_ms >= 1000),
  claim_expires_at   timestamptz,

  -- Terminal markers. These, plus the three deadlines above, ARE the state.
  released_at        timestamptz,
  claimed_at         timestamptz,
  revoked_at         timestamptz,
  revocation_reason  text check (revocation_reason is null or revocation_reason in
                       ('session_cancelled', 'session_moved', 'seat_withdrawn',
                        'safety', 'venue_operations', 'credential_revoked')),

  -- T4: get_hold mints a read_token bound to (hold_id, that read's
  -- server_time); hand_off REQUIRES a fresh one and refuses 409 stale_read
  -- otherwise. Stored as an HMAC so a leaked backup is not a set of live
  -- tokens.
  read_token_hmac    text,
  read_token_at      timestamptz,

  -- T1/T3: floor_deadline = granted_at + floor_ms, and it is immovable. The
  -- CHECK makes a wrong value unwritable; the column-level UPDATE grant in
  -- 0003 makes a later move unwritable by the agent role at all. There is no
  -- extend verb and a Server MUST NOT provide one.
  constraint hold_floor_derived
    check (floor_deadline = granted_at + (floor_ms * interval '1 millisecond')),
  -- T2: expires_at >= floor_deadline at grant and for the life of the Hold.
  constraint hold_expiry_not_before_floor check (expires_at >= floor_deadline),
  -- T6: claim_expires_at >= expires_at >= floor_deadline for the life of it.
  constraint hold_claim_not_before_expiry
    check (claim_expires_at is null or claim_expires_at >= expires_at),
  -- T5/CL4: a hand-off sets all three of its members or none of them.
  constraint hold_handoff_complete
    check ((handed_off_at is null) = (handoff_floor_ms is null)
           and (handed_off_at is null) = (claim_expires_at is null)),
  -- T1a: a revocation carries a reason from the closed enum, always.
  constraint hold_revocation_has_reason
    check ((revoked_at is null) = (revocation_reason is null)),
  -- §4.9: a claim can only follow a hand-off.
  constraint hold_claim_follows_handoff
    check (claimed_at is null or handed_off_at is not null)
);

-- X1's per-(agent_id, principal_scope) budgets and X3's per-agent_id ceilings
-- are counted over these two indexes. The hourly window of
-- max_holds_per_site_per_hour reads the third.
create index hold_principal_showtime_idx on hold (agent_id, principal_scope, showtime_id);
create index hold_agent_origin_idx       on hold (agent_id, origin);
create index hold_principal_granted_idx  on hold (agent_id, principal_scope, origin, granted_at);
create index hold_occasion_idx           on hold (occasion_id);

-- ---------------------------------------------------------------------------
-- Seat occupancy. THE invariant of the whole design.
--
-- "Oversell is made unrepresentable rather than prevented" (SPEC.md:363,
-- ADR-005). A row exists here for as long as a Hold occupies a seat; the reap
-- of §4.6 deletes rows, in the next contending transaction, under that
-- transaction's own seat locks (L1, L2) — never on a sweeper's schedule
-- (ADR-006).
--
-- `state` on THIS table is seat occupancy, not the Hold's derived state. It is
-- the one discriminator a partial index predicate can be built from, because a
-- predicate must be IMMUTABLE and `held_until > now()` is not. The Hold's own
-- state stays derived: see the absence of a `state` column on `hold` above.
-- ---------------------------------------------------------------------------

create table hold_seat (
  hold_id     text not null references hold (hold_id) on delete cascade,
  occasion_id text not null,
  showtime_id text not null,
  seat_id     text not null check (length(seat_id) between 1 and 64),
  state       text not null check (state in
                ('live', 'handed_off', 'claimed', 'released', 'expired', 'revoked')),
  -- T6: held_until = expires_at while live, = claim_expires_at while
  -- handed_off, set in the same transaction as the transition.
  held_until  timestamptz not null,
  -- W2 is enforced before any lock is taken, at schema validation. This primary
  -- key is why a duplicate that slipped through would be a constraint failure
  -- rather than a second row.
  primary key (hold_id, seat_id)
);

-- The floor. The seat-occupying states are `live`, `handed_off` AND `claimed`.
-- `claimed` is terminal, occupies its seat for the life of the screening, and
-- MUST NOT be reaped. The draft's index excluded it, so a sold seat left the
-- uniqueness predicate the instant the order was written and was immediately
-- re-holdable with a 201 Created.
--
-- On the key, SETTLED 2026-08-25. SPEC.md:366 writes this index over
-- (showtime_id, seat_id); ADR-005 wrote it over (occasion_id, seat_id). They
-- are the same index only while showtime_ref is absent, which is true of every
-- golden fixture and is why the divergence survived review.
--
-- SPEC.md is correct and ADR-005 was wrong. The scarce thing is a seat at a
-- PHYSICAL SCREENING, and `showtime_ref` exists precisely so a publisher can
-- map several Occasions onto one screening -- a premiere and a standard
-- listing of the same 7pm show, or two price bands sold as separate Occasions.
-- Keyed on occasion_id, two such Occasions can each hold seat F11 and both
-- commit: the index sees two distinct keys, and the house sells one seat twice.
-- That is oversell arriving through the exact constraint written to make it
-- unrepresentable.
--
-- `locking.ts` already locks on (showtime_id, seat_id) per L1, so the lock was
-- masking the index in the single-Occasion case and would have stopped masking
-- it the first time a real publisher used showtime_ref. ADR-005 is corrected to
-- match the specification rather than the reverse.
create unique index hold_seat_occupied on hold_seat (showtime_id, seat_id)
  where state in ('live', 'handed_off', 'claimed');

-- The reap of §4.6 reads this: it selects DISTINCT hold_id for doomed seats and
-- deletes by HOLD, never by seat, because a Hold is never partially expired.
create index hold_seat_reap_idx on hold_seat (showtime_id, seat_id, held_until)
  where state in ('live', 'handed_off');
-- X4 counts a principal's live held seats on one showtime_id.
create index hold_seat_showtime_idx on hold_seat (showtime_id)
  where state in ('live', 'handed_off', 'claimed');

-- ---------------------------------------------------------------------------
-- Cluster occupancy. X2: a second live Hold in one (origin, cluster) for one
-- principal is 429 cluster_fanout.
--
-- SPEC.md:367 puts this index on `hold` with a `state` predicate. It cannot go
-- there, because M1–M3 three lines further down forbid `hold` a `state` column
-- and a partial index predicate cannot be a function of now(). The resolution
-- is the one the specification itself already uses for hold_slot: occupancy is
-- a ROW, and the row is deleted by the next contending transaction (ADR-006).
-- The index keeps the name SPEC.md:393 maps to a refusal — hold_cluster_live →
-- 429 cluster_fanout — so the constraint-name mapping is satisfied verbatim.
--
-- `claimed` is deliberately NOT in the predicate: once a purchase is done the
-- household may hold again in that cluster. "Two purchases in one cluster by
-- one household are legitimate and are not fan-out."
-- ---------------------------------------------------------------------------

create table hold_cluster (
  hold_id         text primary key references hold (hold_id) on delete cascade,
  agent_id        text not null,
  principal_scope text not null,
  origin          text not null,
  cluster         text not null check (length(cluster) between 1 and 128),
  state           text not null check (state in
                    ('live', 'handed_off', 'claimed', 'released', 'expired', 'revoked')),
  held_until      timestamptz not null
);

create unique index hold_cluster_live
  on hold_cluster (agent_id, principal_scope, origin, cluster)
  where state in ('live', 'handed_off');

create index hold_cluster_reap_idx on hold_cluster (held_until)
  where state in ('live', 'handed_off');

-- ---------------------------------------------------------------------------
-- Hold budget slots. SPEC.md:370, verbatim in shape.
--
-- X1's max_live_holds_per_showtime is per (agent_id, principal_scope) and MUST
-- be enforced inside the insert transaction by a constraint or a lock. A slot
-- in [0, max) is taken by a live Hold and released with it; the (max+1)th
-- insert violates the primary key.
--
-- SPEC.md:393 maps the constraint NAMED `hold_slot` to 429
-- hold_budget_exhausted. That name is unrepresentable: Postgres puts tables and
-- indexes in one namespace, so a constraint called `hold_slot` on a table
-- called `hold_slot` is `42P07 relation "hold_slot" already exists`. The table
-- keeps the specification's name and the constraint is `hold_slot_taken`;
-- import it as CONSTRAINT.hold_slot from ../schema.ts rather than retyping
-- either spelling, and see the spec defect noted in the README. A 23505 whose
-- constraint is anything else MUST NOT be reported as seat_contended.
-- ---------------------------------------------------------------------------

create table hold_slot (
  agent_id        text not null,
  principal_scope text not null,
  showtime_id     text not null,
  slot            integer not null check (slot >= 0),
  hold_id         text not null references hold (hold_id) on delete cascade,
  constraint hold_slot_taken primary key (agent_id, principal_scope, showtime_id, slot),
  constraint hold_slot_one_per_hold unique (hold_id)
);

-- ---------------------------------------------------------------------------
-- Idempotency. §4.5.
--
-- I2: the scope is (agent_id, principal_scope, verb, key), all credential-
-- derived and never read from a body — which is exactly this primary key.
-- I5: same key, different digest is 422 idempotency_key_reused with no action
-- taken, decided by comparing request_digest.
-- I6: a request arriving while an identical key is in flight is 409
-- idempotency_in_flight, decided by `status`.
-- I9: for hand_off the retention window is min(24 hours, claim_expires_at).
--
-- The raw Idempotency-Key is never stored. It is an exact-match lookup key, so
-- an HMAC is lossless for the purpose, and P2's discipline — that a value the
-- boundary does not need in clear is not held in clear — is cheapest to apply
-- everywhere rather than only where a rule names it.
-- ---------------------------------------------------------------------------

create table idempotency (
  agent_id             text not null,
  principal_scope      text not null,
  verb                 text not null check (verb in ('hold_seats', 'hand_off', 'release_hold')),
  idempotency_key_hmac text not null,
  -- I3: SHA-256 over JCS of the request's DECISION MEMBERS ONLY, base64url.
  -- Gate responses, intent_digest, read_token and transport metadata including
  -- the key itself are excluded, which is why a human gate's retry is the same
  -- request and not a 422.
  request_digest       text not null check (request_digest ~ '^[A-Za-z0-9_-]{43}$'),
  status               text not null check (status in ('in_flight', 'stored')),
  hold_id              text references hold (hold_id) on delete cascade,
  -- The stored response document, replayed under I4. A Hold document, which by
  -- its own schema carries no personal data.
  record               jsonb,
  created_at           timestamptz not null,
  retention_until      timestamptz not null,
  constraint idempotency_scope
    primary key (agent_id, principal_scope, verb, idempotency_key_hmac),
  -- I7: an InputRequiredResult is not an operation and records no entry, so
  -- every row here is either in flight or holds a response.
  constraint idempotency_stored_has_record
    check (status <> 'stored' or record is not null)
);

create index idempotency_retention_idx on idempotency (retention_until);
