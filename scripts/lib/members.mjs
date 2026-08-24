// Collect every member name declared by a schema — the keys of every
// `properties` object, at every depth. Deliberately a SUPERSET of "leaf
// members": container names are members too, and a manifest that ignored them
// would let `patron { name, email }` arrive with only its leaves scrutinised.
// $defs KEYS are definition names, not members, and are not collected; the
// `properties` inside those definitions are.

export function collectMembers(node, into = new Set()) {
  if (node === null || typeof node !== 'object') return into;
  if (Array.isArray(node)) { for (const item of node) collectMembers(item, into); return into; }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const member of Object.keys(value)) into.add(member);
    }
    collectMembers(value, into);
  }
  return into;
}

export const DOCUMENT_SCHEMAS = [
  'schemas/occasion.schema.json',
  'schemas/substitution.schema.json',
  'schemas/substitution-policy.schema.json',
  'schemas/hold-policy.schema.json',
  'schemas/hold.schema.json',
  'schemas/refusal.schema.json',
  'schemas/capability.schema.json',
  'schemas/seatmap.schema.json',
];
