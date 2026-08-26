/**
 * poset-generator.ts — fast-check arbitraries over candidate sets.
 *
 * This is INPUT, not implementation: both `maximalAntichain` and the
 * independent oracle are fed from here, which is the only file the two are
 * allowed to have in common.
 *
 * Three properties of the generated data are deliberate, not convenient:
 *
 *   G1  At least two candidates. One Occasion has nothing to be distinguished
 *       from, and the distinguishing-axes annotation is empty by construction.
 *       That boundary is asserted separately, as a boundary.
 *
 *   G2  Every candidate carries a DISTINCT (instant, auditorium) pair. That is
 *       not a simplification: SPEC.md §2.1 makes an Occasion "this work, in
 *       this room, at this instant, in this manner", so two candidates sharing
 *       both are one screening published twice. Instants repeat ACROSS
 *       auditoria, so `instant` is not always a distinguishing axis and the
 *       annotation property has to do real work.
 *
 *   G3  The ids are deliberately NOT in lexical order. Document order and
 *       sorted order differ for every generated set, so an implementation that
 *       quietly sorts by `occasion_id` — which Z3 forbids an Agent from doing —
 *       disagrees with the oracle immediately instead of at integration.
 *
 * Edge density is about 30%: dense enough to build chains and cycles, sparse
 * enough that antichains of more than one member are the common case.
 */

import fc from "fast-check";

export type GenAxis =
  | "instant" | "auditorium" | "presentation_class" | "occasion_class"
  | "price_band" | "seat" | "accessibility";

export interface GenEdge {
  occasion_id: string;
  axis: GenAxis;
}

export interface GenCandidate {
  occasion_id: string;
  policy: "strict" | "advisory";
  presentation_classes: string[];
  occasion_classes: string[];
  accepts_substitute: GenEdge[];
  not_substitutable_for: GenEdge[];
  facets: {
    instant: string;
    auditorium_id: string;
    seating: string;
    price_bands: string[];
    accessibility: Record<string, string>;
  };
}

const GEN_AXES: GenAxis[] = [
  "instant", "auditorium", "presentation_class", "occasion_class",
  "price_band", "seat", "accessibility",
];

/** G3: not in lexical order, on purpose. */
const ID_TOKENS = ["k9f", "a2b", "z7q", "c4d", "m1n", "b8r", "q3s", "e5t"];

const INSTANTS = [
  "2026-08-29T19:00:00+12:00",
  "2026-08-29T21:00:00+12:00",
  "2026-08-30T14:00:00+12:00",
];

const AUDITORIA = ["aud_grand", "aud_four", "aud_seven"];
const SEATING = ["allocated", "unallocated", "unknown"];

const PRES_SETS: string[][] = [
  ["pres:35mm-4perf", "pres:sound-optical"],
  ["pres:dcp-2k-flat", "pres:sound-5-1"],
  ["pres:dcp-4k-scope", "pres:sound-atmos"],
  ["pres:dcp-2k-flat", "pres:open-caption"],
  ["pres:70mm-5perf", "pres:sound-atmos"],
];

const OCC_SETS: string[][] = [
  [],
  ["occ:archival-print"],
  ["occ:final-run"],
  ["occ:archival-print", "occ:final-run"],
];

/** Mostly absent, because an extension class is meant to be rare. */
const EXT_SETS: string[][] = [
  [], [], [], [],
  ["x-drive-in"],
  ["x-singalong"],
  ["x-drive-in", "x-live-score"],
];

const BAND_SETS: string[][] = [
  ["General admission"],
  ["Matinee"],
  ["Members"],
  ["General admission", "Concession"],
  [],
];

const ACCESS_SETS: Record<string, string>[] = [
  { open_captions: "no", audio_description: "no", wheelchair_spaces: "yes" },
  { open_captions: "yes", audio_description: "no", wheelchair_spaces: "yes" },
  { open_captions: "no", audio_description: "yes", wheelchair_spaces: "yes" },
  { open_captions: "unknown", audio_description: "no", wheelchair_spaces: "no" },
];

interface Draw {
  edgeRoll: number[];
  edgeAxis: number[];
  negRoll: number[];
  negAxis: number[];
  pres: number[];
  occ: number[];
  ext: number[];
  band: number[];
  access: number[];
  seat: number[];
  policy: ("strict" | "advisory")[];
  phantom: number[];
}

function assemble(size: number, draw: Draw, extensions: boolean): GenCandidate[] {
  const ids = ID_TOKENS.slice(0, size).map((token) => `occ_${token}`);
  const out: GenCandidate[] = [];

  for (let i = 0; i < size; i++) {
    const extension = extensions ? EXT_SETS[draw.ext[i] % EXT_SETS.length] : [];
    // An x- class can sit on either array; alternating exercises both surfaces.
    const onPresentation = i % 2 === 0;

    const accepts: GenEdge[] = [];
    const refuses: GenEdge[] = [];
    for (let j = 0; j < size; j++) {
      if (i === j) continue;
      if (draw.edgeRoll[i * size + j] < 3) {
        accepts.push({ occasion_id: ids[j], axis: GEN_AXES[draw.edgeAxis[i * size + j] % GEN_AXES.length] });
      }
      if (draw.negRoll[i * size + j] < 2) {
        refuses.push({ occasion_id: ids[j], axis: GEN_AXES[draw.negAxis[i * size + j] % GEN_AXES.length] });
      }
    }
    // E2 / S3: an edge naming an Occasion outside the resolved set. Inert for
    // the antichain, still enforced at commit. Both implementations must ignore it here.
    if (draw.phantom[i] < 2) {
      accepts.push({ occasion_id: `occ_unresolved_${i}`, axis: "presentation_class" });
    }

    out.push({
      occasion_id: ids[i],
      policy: draw.policy[i],
      presentation_classes: [
        ...PRES_SETS[draw.pres[i] % PRES_SETS.length],
        ...(onPresentation ? extension : []),
      ],
      occasion_classes: [
        ...OCC_SETS[draw.occ[i] % OCC_SETS.length],
        ...(onPresentation ? [] : extension),
      ],
      accepts_substitute: accepts,
      not_substitutable_for: refuses,
      facets: {
        instant: INSTANTS[i % INSTANTS.length],
        auditorium_id: AUDITORIA[Math.floor(i / INSTANTS.length) % AUDITORIA.length],
        seating: SEATING[draw.seat[i] % SEATING.length],
        price_bands: BAND_SETS[draw.band[i] % BAND_SETS.length],
        accessibility: ACCESS_SETS[draw.access[i] % ACCESS_SETS.length],
      },
    });
  }
  return out;
}

export interface CandidateSetOptions {
  minSize?: number;
  maxSize?: number;
  /** false suppresses every `x-` class, isolating the ordinary preorder. */
  extensions?: boolean;
}

/** A generated candidate set: the resolved set C plus its attested edges E. */
export function candidateSetArbitrary(options?: CandidateSetOptions): fc.Arbitrary<GenCandidate[]> {
  const minSize = options?.minSize ?? 2;
  const maxSize = options?.maxSize ?? ID_TOKENS.length;
  const extensions = options?.extensions ?? true;

  return fc.integer({ min: minSize, max: maxSize }).chain((size) =>
    fc
      .record({
        edgeRoll: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size * size, maxLength: size * size }),
        edgeAxis: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: size * size, maxLength: size * size }),
        negRoll: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size * size, maxLength: size * size }),
        negAxis: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: size * size, maxLength: size * size }),
        pres: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
        occ: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
        ext: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
        band: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
        access: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
        seat: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
        policy: fc.array(fc.constantFrom<"strict" | "advisory">("strict", "advisory"), {
          minLength: size,
          maxLength: size,
        }),
        phantom: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: size, maxLength: size }),
      })
      .map((draw) => assemble(size, draw, extensions)),
  );
}

/**
 * The sharp case: an ATTESTED edge that would establish domination, crossed by
 * an `x-` class that must void it in both directions.
 *
 * `lower` attests `lower <= upper`, and nothing is attested back. Without the
 * extension rule `upper` strictly dominates `lower` and `lower` is dropped.
 * `upper` carries an `x-` class `lower` does not, so domination is established
 * in NEITHER direction, both survive, and the edge does not satisfy `lower`'s
 * strict policy.
 */
export function extensionCaseArbitrary(): fc.Arbitrary<{
  candidates: GenCandidate[];
  lower_id: string;
  upper_id: string;
  token: string;
}> {
  return fc
    .record({
      axis: fc.constantFrom<GenAxis>(...GEN_AXES),
      token: fc.constantFrom("x-drive-in", "x-singalong", "x-live-score", "x-35mm-preshow"),
      onPresentation: fc.boolean(),
      pres: fc.integer({ min: 0, max: 4 }),
      seat: fc.integer({ min: 0, max: 2 }),
      band: fc.integer({ min: 0, max: 4 }),
      access: fc.integer({ min: 0, max: 3 }),
    })
    .map((draw) => {
      const lower_id = "occ_k9f";
      const upper_id = "occ_a2b";
      const base: string[] = PRES_SETS[draw.pres];

      const lower: GenCandidate = {
        occasion_id: lower_id,
        policy: "strict",
        presentation_classes: [...base],
        occasion_classes: [],
        accepts_substitute: [{ occasion_id: upper_id, axis: draw.axis }],
        not_substitutable_for: [],
        facets: {
          instant: INSTANTS[0],
          auditorium_id: AUDITORIA[0],
          seating: SEATING[draw.seat],
          price_bands: BAND_SETS[draw.band],
          accessibility: ACCESS_SETS[draw.access],
        },
      };

      const upper: GenCandidate = {
        occasion_id: upper_id,
        policy: "strict",
        presentation_classes: draw.onPresentation ? [...base, draw.token] : [...base],
        occasion_classes: draw.onPresentation ? [] : [draw.token],
        accepts_substitute: [],
        not_substitutable_for: [],
        facets: {
          instant: INSTANTS[1],
          auditorium_id: AUDITORIA[0],
          seating: SEATING[draw.seat],
          price_bands: BAND_SETS[draw.band],
          accessibility: ACCESS_SETS[draw.access],
        },
      };

      return { candidates: [lower, upper], lower_id, upper_id, token: draw.token };
    });
}
