// The frozen schemas, compiled. Owner: ADAPT-001. Shared with the proof script.
//
// **Why this is under `test/` and not under `src/`.** `ajv` is not a declared
// dependency of `@changeover/adapter-reference`, and it should not become one:
// an adapter's job is to produce documents, and a Server that validated its own
// output on every request would be paying for a check that belongs to the
// conformance harness and to CI. `packages/core/test/lib/hold-fixtures.ts` set
// the precedent — a test-tree module named as a precondition by a proof script —
// and `scripts/prove_reference_adapter.sh` names this one the same way.
//
// **One sharp edge, and it is a real finding.** Compiling
// `capability.schema.json` under ajv's `strict: true` THROWS:
//
//     strict mode: required property "occasions_url" is not defined at
//     "urn:changeover:schema:capability:0.1#/anyOf/0" (strictRequired)
//
// `strictRequired` is a lint about schema AUTHORING — it wants every name in a
// `required` array to be defined in `properties` **at the same subschema level**
// — and the capability schema's `anyOf` deliberately requires two members that
// are defined once, at the root. The schema is correct; the lint does not model
// this shape. So `strictRequired` is off here and every other strict check stays
// on. Nothing about instance validation is weakened: `additionalProperties:
// false`, `required`, formats and the `$ref`s all still bind.
//
// This is also why no capability document in this repository was being validated
// before now — `prove_spec_examples.sh` adds the schema but never compiles it,
// because SPEC.md prints no capability payload for it to reach.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// `ajv` and `ajv-formats` are CommonJS with `export =`, so under
// `verbatimModuleSyntax` TypeScript sees the module namespace rather than the
// constructor Node hands back. The two casts are the whole of the interop and
// they are confined to this file; nothing in `src/` touches ajv at all.
type CompiledSchema = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addSchema(schema: unknown): unknown;
  getSchema(id: string): CompiledSchema | undefined;
  errorsText(errors: unknown, options?: { separator?: string }): string;
}
type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;
const Ajv2020 = AjvModule as unknown as AjvConstructor;
const addFormats = addFormatsModule as unknown as (ajv: AjvInstance) => void;

/** The eight document schemas plus `common`, exactly as the frozen proofs load them. */
export const SCHEMA_NAMES: readonly string[] = Object.freeze([
  "common",
  "occasion",
  "substitution",
  "substitution-policy",
  "hold-policy",
  "hold",
  "refusal",
  "capability",
  "seatmap",
]);

export const REPO_ROOT: string = fileURLToPath(new URL("../../../../", import.meta.url));

export interface Validator {
  /** `null` where the value validates; otherwise ajv's error text. */
  (schema_id: string, value: unknown): string | null;
}

export function schemaValidator(): Validator {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
    // See the note above. An authoring lint, not an instance check.
    strictRequired: false,
  });
  addFormats(ajv);
  for (const name of SCHEMA_NAMES) {
    ajv.addSchema(JSON.parse(readFileSync(`${REPO_ROOT}schemas/${name}.schema.json`, "utf8")));
  }
  return (schema_id: string, value: unknown): string | null => {
    const validate = ajv.getSchema(schema_id);
    if (validate === undefined) throw new Error(`no compiled schema for ${schema_id}`);
    return validate(value) ? null : ajv.errorsText(validate.errors, { separator: "; " });
  };
}

export const CAPABILITY_SCHEMA_ID = "urn:changeover:schema:capability:0.1";
export const HOLD_SCHEMA_ID = "urn:changeover:schema:hold:0.1";
export const SEATMAP_SCHEMA_ID = "urn:changeover:schema:seatmap:0.1";
export const OCCASION_SCHEMA_ID = "urn:changeover:schema:occasion:0.1";
