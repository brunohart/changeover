/**
 * The frozen document schemas, made self-contained.
 *
 * SEP-2106 requires `inputSchema` and `outputSchema` to be full JSON Schema
 * 2020-12. The eight frozen schemas in `schemas/` already are — but they
 * `$ref` each other by URN (`urn:changeover:schema:common:0.1#/$defs/etag`),
 * and **no MCP client can resolve a URN**. There is no retrieval protocol for
 * one; there is deliberately no HTTP URL, because §6.3 refuses a URL type on
 * the grounds that it implies a domain that must resolve and this project's
 * domain is unverified. So a tool schema that shipped those `$ref`s would be a
 * 2020-12 document that no consumer could compile — which is the same as no
 * schema at all, arriving with the paperwork of one.
 *
 * Hence bundling: every referenced schema is inlined under the root's own
 * `$defs`, under a slug, with its internal pointers rewritten to match. The
 * output is one document, resolvable with no network and no registry.
 *
 * **The point of reading them from disk rather than re-typing them** is that
 * `schemas/hold.schema.json` is frozen and this file cannot drift from it. A
 * hand-written `outputSchema` for `hold_seats` would be a second opinion about
 * what a Hold is, and the two would disagree the first time either moved.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Repository-relative `schemas/`, from `packages/mcp/src/`. */
export const SCHEMA_DIR = join(import.meta.dirname, "..", "..", "..", "schemas");

export const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

type Json = unknown;
type JsonObject = Record<string, Json>;

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `*.schema.json` in `schemas/`, indexed by its own `$id`. */
function loadByIri(): ReadonlyMap<string, JsonObject> {
  const byIri = new Map<string, JsonObject>();
  for (const name of readdirSync(SCHEMA_DIR)) {
    if (!name.endsWith(".schema.json")) continue;
    const document = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as JsonObject;
    const id = document.$id;
    if (typeof id === "string") byIri.set(id, document);
  }
  return byIri;
}

const BY_IRI = loadByIri();

/** `urn:changeover:schema:hold-policy:0.1` → `hold_policy_0_1`. */
function slugOf(iri: string): string {
  return iri.replace(/^urn:changeover:schema:/, "").replace(/[^A-Za-z0-9]+/g, "_");
}

interface Bundler {
  readonly defs: JsonObject;
  readonly slugs: Map<string, string>;
}

/**
 * A pointer into an inlined document. `#` becomes `#/$defs/<slug>`, and
 * `#/$defs/etag` becomes `#/$defs/<slug>/$defs/etag` — the inlined document
 * keeps its own `$defs` subtree rather than having it flattened into the
 * root's, so two schemas that both define `$defs/opaqueId` cannot collide.
 */
function pointerInto(slug: string, fragment: string): string {
  if (fragment === "" || fragment === "#") return `#/$defs/${slug}`;
  return `#/$defs/${slug}${fragment.slice(1)}`;
}

function inlineDocument(iri: string, bundler: Bundler): string {
  const existing = bundler.slugs.get(iri);
  if (existing !== undefined) return existing;

  const document = BY_IRI.get(iri);
  if (document === undefined) {
    throw new Error(`bundle: no schema in ${SCHEMA_DIR} declares $id ${iri}`);
  }
  const slug = slugOf(iri);
  // Registered before the walk, so a schema that refers to itself terminates.
  bundler.slugs.set(iri, slug);
  bundler.defs[slug] = null;

  const { $id: _id, $schema: _schema, ...body } = document;
  bundler.defs[slug] = rewrite(body, bundler, slug) as JsonObject;
  return slug;
}

/**
 * `owner` is the slug of the inlined document this node came from, or `null`
 * for the root. A local `#/…` pointer inside an inlined document must be
 * re-based onto that document's new home; the same pointer at the root is
 * already correct and is left exactly as authored.
 */
function rewrite(node: Json, bundler: Bundler, owner: string | null): Json {
  if (Array.isArray(node)) return node.map((item) => rewrite(item, bundler, owner));
  if (!isObject(node)) return node;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out.$ref = rewriteRef(value, bundler, owner);
      continue;
    }
    out[key] = rewrite(value, bundler, owner);
  }
  return out;
}

function rewriteRef(ref: string, bundler: Bundler, owner: string | null): string {
  if (ref.startsWith("#")) {
    return owner === null ? ref : pointerInto(owner, ref);
  }
  const hash = ref.indexOf("#");
  const iri = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? "" : ref.slice(hash);
  const slug = inlineDocument(iri, bundler);
  return pointerInto(slug, fragment);
}

/**
 * One frozen document schema, self-contained: dialect declared, every URN
 * `$ref` inlined, no `$id` (an `$id` on a tool schema would re-open the
 * resolution question this function exists to close).
 */
export function bundle(iri: string): JsonObject {
  const document = BY_IRI.get(iri);
  if (document === undefined) {
    throw new Error(`bundle: no schema in ${SCHEMA_DIR} declares $id ${iri}`);
  }
  const bundler: Bundler = { defs: {}, slugs: new Map() };
  const { $id: _id, $schema: _schema, ...body } = document;
  const rewritten = rewrite(body, bundler, null) as JsonObject;

  const own = isObject(rewritten.$defs) ? rewritten.$defs : {};
  for (const slug of Object.keys(bundler.defs)) {
    if (Object.hasOwn(own, slug)) {
      throw new Error(`bundle: inlined slug ${slug} collides with a $defs member of ${iri}`);
    }
  }
  const $defs = { ...own, ...bundler.defs };

  const bundled: JsonObject = { $schema: DIALECT_2020_12, ...rewritten };
  if (Object.keys($defs).length > 0) bundled.$defs = $defs;
  return bundled;
}

/** The schema IRIs this binding puts on the wire. */
export const SCHEMA_IRI = {
  hold: "urn:changeover:schema:hold:0.1",
  occasion: "urn:changeover:schema:occasion:0.1",
  refusal: "urn:changeover:schema:refusal:0.1",
} as const;
