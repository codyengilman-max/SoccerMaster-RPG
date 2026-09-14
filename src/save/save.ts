import type { CampaignState } from "../campaign/campaign";

/**
 * Versioned saves (spec §22; plan §3.4). A save is plain JSON: `{ version, savedAt, campaign }`.
 * Loading runs every migration from the file's version up to `SAVE_VERSION` and then validates
 * the shape. Storage is behind `SaveStore` so the browser (localStorage) and tests (memory) share
 * one code path.
 */

export const SAVE_VERSION = 1;

export interface SaveFile {
  version: number;
  savedAt: string;
  slot: string;
  campaign: CampaignState;
}

export interface SaveSummary {
  slot: string;
  savedAt: string;
  version: number;
  playerName: string;
  kind: CampaignState["kind"];
  day: number;
  revision: number;
}

export interface SaveStore {
  list(): SaveSummary[];
  read(slot: string): string | null;
  write(slot: string, json: string): void;
  remove(slot: string): void;
}

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** Index i migrates version i → i+1. Version 1 is the first shipped schema, so the list is empty. */
export const MIGRATIONS: readonly Migration[] = [];

export class SaveError extends Error {
  constructor(
    message: string,
    readonly code: "corrupt" | "unsupported_version" | "invalid_shape",
  ) {
    super(message);
  }
}

export function serialize(campaign: CampaignState, slot: string, now = new Date()): string {
  const file: SaveFile = { version: SAVE_VERSION, savedAt: now.toISOString(), slot, campaign };
  return JSON.stringify(file);
}

export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let v = typeof raw.version === "number" ? raw.version : 0;
  if (v < 1) throw new SaveError(`save version ${v} is not supported`, "unsupported_version");
  if (v > SAVE_VERSION) throw new SaveError(`save version ${v} is newer than this build (${SAVE_VERSION})`, "unsupported_version");
  let cur = raw;
  while (v < SAVE_VERSION) {
    const m = MIGRATIONS[v - 1];
    if (!m) throw new SaveError(`no migration from version ${v}`, "unsupported_version");
    cur = { ...m(cur), version: v + 1 };
    v++;
  }
  return cur;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function validate(file: Record<string, unknown>): SaveFile {
  const c = file.campaign;
  if (!isObj(c)) throw new SaveError("missing campaign", "invalid_shape");
  const need: (keyof CampaignState)[] = ["id", "seed", "kind", "player", "ageGroup", "day", "revision", "schedule", "competitions", "roster", "story", "progression", "reports"];
  for (const k of need) if (!(k in c)) throw new SaveError(`campaign.${k} missing`, "invalid_shape");
  if (typeof file.savedAt !== "string" || typeof file.slot !== "string") throw new SaveError("bad header", "invalid_shape");
  return { version: SAVE_VERSION, savedAt: file.savedAt, slot: file.slot, campaign: c as unknown as CampaignState };
}

export function deserialize(json: string): SaveFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SaveError("save is not valid JSON", "corrupt");
  }
  if (!isObj(raw)) throw new SaveError("save is not an object", "corrupt");
  return validate(migrate(raw));
}

export function summarize(file: SaveFile): SaveSummary {
  return {
    slot: file.slot,
    savedAt: file.savedAt,
    version: file.version,
    playerName: file.campaign.player.name,
    kind: file.campaign.kind,
    day: file.campaign.day,
    revision: file.campaign.revision,
  };
}

export function saveCampaign(store: SaveStore, slot: string, campaign: CampaignState, now = new Date()): SaveSummary {
  const json = serialize(campaign, slot, now);
  store.write(slot, json);
  return summarize(deserialize(json));
}

export function loadCampaign(store: SaveStore, slot: string): CampaignState | null {
  const json = store.read(slot);
  if (json === null) return null;
  return deserialize(json).campaign;
}

export class MemoryStore implements SaveStore {
  private data = new Map<string, string>();
  list(): SaveSummary[] {
    return [...this.data.values()].map((j) => summarize(deserialize(j)));
  }
  read(slot: string): string | null {
    return this.data.get(slot) ?? null;
  }
  write(slot: string, json: string): void {
    this.data.set(slot, json);
  }
  remove(slot: string): void {
    this.data.delete(slot);
  }
}

const PREFIX = "smrpg:save:";

export class LocalStorageStore implements SaveStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}
  list(): SaveSummary[] {
    const out: SaveSummary[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const j = this.storage.getItem(k);
      if (!j) continue;
      try {
        out.push(summarize(deserialize(j)));
      } catch {
        // an unreadable slot is listed nowhere; it is never deleted silently
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  read(slot: string): string | null {
    return this.storage.getItem(PREFIX + slot);
  }
  write(slot: string, json: string): void {
    this.storage.setItem(PREFIX + slot, json);
  }
  remove(slot: string): void {
    this.storage.removeItem(PREFIX + slot);
  }
}
