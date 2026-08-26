// A trivial module whose only job is to be imported from another package's
// test, under `node --test`, with no build step. If this stops resolving, the
// toolchain changed and every convention in docs/BUILD-CONTRACT.md is suspect.
//
// Owner: CONTRACT-000.

export type Cue = "changeover" | "reel_end";

/** `as const` object + union type. This is what a TypeScript enum is spelled as here. */
export const CUE = {
  changeover: "changeover",
  reel_end: "reel_end",
} as const;

export type CueName = (typeof CUE)[keyof typeof CUE];

export interface Frame {
  readonly cue: CueName;
  readonly at_ms: number;
}

export function frame(cue: CueName, at_ms: number): Frame {
  return { cue, at_ms };
}
