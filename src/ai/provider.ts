/**
 * Optional dialogue provider (spec §20). A provider may rephrase an authored line using approved
 * facts and the meaning of a choice; it never carries effects and its output is discarded when
 * stale. The default provider is authored-only, so the game is playable without AI (acceptance 16).
 */

export interface DialogueRequest {
  /** Monotonic save revision when the request was made; a response for an older revision is stale. */
  revision: number;
  /** Unique per request; a response must echo it. */
  token: string;
  sceneId: string;
  speakerId: string;
  /** The authored line — always the fallback. */
  authored: string;
  /** Facts the speaker is allowed to reference (ids → values). */
  approvedFacts: Record<string, string | number | boolean>;
  /** What the player's last choice meant, in authored words. */
  choiceMeaning: string | null;
}

export interface DialogueResponse {
  token: string;
  revision: number;
  text: string;
}

export interface DialogueProvider {
  readonly name: string;
  available(): boolean;
  render(req: DialogueRequest): Promise<DialogueResponse | null>;
}

/** Authored text only. */
export class AuthoredProvider implements DialogueProvider {
  readonly name = "authored";
  available(): boolean {
    return false;
  }
  render(_req: DialogueRequest): Promise<DialogueResponse | null> {
    return Promise.resolve(null);
  }
}

export type Accepted = { ok: true; text: string } | { ok: false; reason: "stale_revision" | "token_mismatch" | "empty" | "unavailable"; text: string };

/**
 * Decide what to show: the provider's text only if it answers this exact request at the current
 * revision; otherwise the authored line. Stale answers cannot leak effects because they carry none.
 */
export function acceptResponse(req: DialogueRequest, res: DialogueResponse | null, currentRevision: number): Accepted {
  if (!res) return { ok: false, reason: "unavailable", text: req.authored };
  if (res.token !== req.token) return { ok: false, reason: "token_mismatch", text: req.authored };
  if (res.revision !== currentRevision || req.revision !== currentRevision) return { ok: false, reason: "stale_revision", text: req.authored };
  if (!res.text.trim()) return { ok: false, reason: "empty", text: req.authored };
  return { ok: true, text: res.text };
}

let tokenSeq = 0;
export const nextToken = (): string => `dlg-${++tokenSeq}`;
