import type { OnBallOption } from "../sim/ai";
import type { RoleId } from "../sim/types";

/**
 * Answer-set rule (spec §16): when the controlled player is on the ball, the engine's own
 * highest-scoring `evaluateOnBall` option must be reproducible from the displayed answers unless
 * the omission is listed here with a soccer reason. Tests fail on any undocumented omission.
 */
export interface DocumentedExclusion {
  /** Catalog role the exclusion applies to. */
  role: RoleId;
  /** Engine option kind that the role's on-ball entries deliberately never offer. */
  kind: OnBallOption["kind"];
  reason: string;
}

export const DOCUMENTED_EXCLUSIONS: readonly DocumentedExclusion[] = [
  {
    role: "GK",
    kind: "carry",
    reason:
      "Keepers distribute rather than dribble out: the engine already penalises a keeper carry (−0.8) and the catalog offers short, long, skip-lines and switch distribution instead.",
  },
];

export function isDocumentedExclusion(role: RoleId, kind: OnBallOption["kind"]): boolean {
  return DOCUMENTED_EXCLUSIONS.some((x) => x.role === role && x.kind === kind);
}
