import { createCampaign, type CampaignState, type CreateOptions } from "../campaign/campaign";
import { loadCampaign, saveCampaign, type SaveStore, type SaveSummary } from "../save/save";
import { openingScenes, startOpening } from "../story/flow";
import type { Scene } from "../story/scenes";

/**
 * One running campaign plus its autosave. Screens mutate the campaign through the story/flow and
 * training modules and call `save()` at every transition; nothing here knows about the DOM.
 */

export const AUTOSAVE_SLOT = "auto";

export interface Session {
  campaign: CampaignState;
  scenes: readonly Scene[];
  save(): SaveSummary;
}

export function savedSummary(store: SaveStore, slot = AUTOSAVE_SLOT): SaveSummary | null {
  return store.list().find((s) => s.slot === slot) ?? null;
}

export function newSession(store: SaveStore, opts: CreateOptions, slot = AUTOSAVE_SLOT): Session {
  const campaign = createCampaign(opts);
  startOpening(campaign);
  return wrap(store, campaign, slot);
}

export function resumeSession(store: SaveStore, slot = AUTOSAVE_SLOT): Session | null {
  const campaign = loadCampaign(store, slot);
  return campaign ? wrap(store, campaign, slot) : null;
}

function wrap(store: SaveStore, campaign: CampaignState, slot: string): Session {
  const s: Session = {
    campaign,
    scenes: openingScenes(campaign.kind),
    save: () => saveCampaign(store, slot, campaign),
  };
  s.save();
  return s;
}
