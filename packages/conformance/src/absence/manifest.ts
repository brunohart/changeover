/**
 * C-ABSENCE.2 — Lock 2, set equality against the member allowlist.
 * Owner: TEST-004.
 *
 * `scripts/prove_member_manifest.sh` has asserted this since commit one, using
 * `scripts/lib/members.mjs`. This is a **second, independent** collector, and
 * the independence is the point: a manifest checked only by the collector that
 * built it is a tautology, exactly as C-ETAG refuses to let an implementation
 * import the harness projector. The two walks are written differently — that one
 * recurses, this one carries an explicit stack — and they must agree to the
 * member.
 *
 * The list of document schemas is **written down here, not discovered on disk**.
 * `schemas/report.schema.json` is a harness schema and TEST-007 adds it in this
 * directory; a collector that globbed `schemas/*.schema.json` would drag the
 * report's member names into a set-equality check against a manifest that
 * correctly does not carry them, and the failure would name a member nobody
 * could place. `scripts/prove_write_path_pii_absent.sh` cross-checks this list
 * against the frozen one so the two cannot drift apart in silence.
 */

export const DOCUMENT_SCHEMAS: readonly string[] = Object.freeze([
  "schemas/capability.schema.json",
  "schemas/hold-policy.schema.json",
  "schemas/hold.schema.json",
  "schemas/occasion.schema.json",
  "schemas/refusal.schema.json",
  "schemas/seatmap.schema.json",
  "schemas/substitution-policy.schema.json",
  "schemas/substitution.schema.json",
]);

/**
 * Every member name a schema declares: the keys of every `properties` object at
 * every depth. `$defs` keys are definition names rather than members and are not
 * collected; the `properties` inside a definition are.
 *
 * A superset of "leaf members" on purpose. A container is a member too, and a
 * manifest that only scrutinised leaves would let `patron { name, email }`
 * arrive with its container unnamed.
 */
export function declaredMembers(schema: unknown): Set<string> {
  const found = new Set<string>();
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        key === "properties" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        for (const member of Object.keys(value as Record<string, unknown>)) found.add(member);
      }
      stack.push(value);
    }
  }
  return found;
}

export interface SetEquality {
  readonly declared: number;
  readonly listed: number;
  /** Declared by a schema, absent from the manifest. A member that arrived unnamed. */
  readonly unmanifested: string[];
  /** Listed in the manifest, declared by no schema. A name outliving its member. */
  readonly orphans: string[];
  readonly equal: boolean;
}

export function setEquality(declared: Set<string>, listed: Set<string>): SetEquality {
  const unmanifested = [...declared].filter((m) => !listed.has(m)).sort();
  const orphans = [...listed].filter((m) => !declared.has(m)).sort();
  return {
    declared: declared.size,
    listed: listed.size,
    unmanifested,
    orphans,
    equal: unmanifested.length === 0 && orphans.length === 0,
  };
}
