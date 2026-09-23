-- CHANGEOVER 0004 — the index resolve_occasions pages on. SPEC.md §6.3.
--
-- Owner: CORE-001. The reader is @changeover/http/occasions.ts, STORE_OCCASIONS.page (BIND-001).
--
-- A page is `withdrawn = false and document is not null`, ordered by
-- (starts_at, occasion_id), continued by a keyset predicate on the same pair.
-- Without this index every page, the first included, sorted every published
-- Occasion to return 201 of them: about 70 ms at 200,000 Occasions, 0.25 ms
-- with it. Partial on the page's own predicate, so a withdrawn Occasion or an
-- unpublished row costs nothing here.
create index occasion_page_idx on occasion (starts_at, occasion_id)
  where withdrawn = false and document is not null;
