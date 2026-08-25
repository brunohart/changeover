/**
 * The input schemas, compiled and actually run.
 *
 * A published `inputSchema` that the Server does not itself enforce is worse
 * than none: it tells every caller a constraint holds while the Server accepts
 * violations of it, so the first thing to notice the gap is a Hold document
 * that fails `hold.schema.json` on the way out — which is §6.2's own worked
 * failure, the Server that accepted `"sarah.chen@gmail.com"` as an
 * `intent_digest` and echoed it.
 *
 * Compiled with `strict: true`, which is a claim about **these schemas** as
 * much as about the arguments: ajv's strict mode rejects a schema with an
 * ignored keyword or a `required` naming a property the branch does not
 * declare, so a typo in `tools.ts` fails at construction rather than silently
 * validating nothing.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

import { TOOLS } from "./tools.ts";

/**
 * A validator configured the way §6.2's claim requires: 2020-12, `strict`, and
 * with the standard format vocabulary **registered rather than ignored**.
 *
 * `strict` plus an unregistered `format` is a hard error, not a warning, and
 * that is the correct behaviour: `occasion.schema.json` declares
 * `format: "date"` on `work.release_date_local`, and a validator that silently
 * ignored it would report a schema as satisfied while never having checked one
 * of its constraints. Exported so the proof scripts assert against the same
 * configuration this Server runs — a compile check under looser settings than
 * the Server uses proves the wrong schema.
 */
export function ajv2020(): InstanceType<typeof Ajv2020.default> {
  const instance = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(instance);
  return instance;
}

export interface ToolValidators {
  /** `null` where the arguments conform; otherwise a one-line summary of why not. */
  validateInput(name: string, args: unknown): string | null;
  /** The same, for a result this binding is about to emit. */
  validateOutput(name: string, document: unknown): string | null;
}

function summarise(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unspecified";
  return errors
    .slice(0, 4)
    .map((error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message}`)
    .join("; ");
}

export function compileToolValidators(): ToolValidators {
  // One Ajv per schema. Sharing an instance would mean sharing a `$ref`
  // resolution scope across ten bundles that each define `$defs/common_0_1`,
  // and the second registration is a duplicate-id error rather than a merge.
  const inputs = new Map<string, ValidateFunction>();
  const outputs = new Map<string, ValidateFunction>();

  for (const tool of TOOLS) {
    inputs.set(tool.name, ajv2020().compile(tool.inputSchema));
    outputs.set(tool.name, ajv2020().compile(tool.outputSchema));
  }

  const run = (
    table: Map<string, ValidateFunction>,
    name: string,
    value: unknown,
    what: string,
  ): string | null => {
    const validate = table.get(name);
    if (validate === undefined) return `no ${what} for ${name}`;
    // `tools/call` may omit `arguments` entirely, and an omitted object is an
    // empty one — not a reason to skip validation, since `required` is exactly
    // what an empty object violates.
    return validate(value ?? {}) ? null : summarise(validate.errors);
  };

  return {
    validateInput: (name, args) => run(inputs, name, args, "inputSchema"),
    validateOutput: (name, document) => run(outputs, name, document, "outputSchema"),
  };
}
