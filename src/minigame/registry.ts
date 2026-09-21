import type { GameLogic, MinigameId } from "./contract";
import { groupPresentation } from "./groupPresentation";
import { worldCupKnockout } from "./worldCupKnockout";

/**
 * The eight games behind one interface. Phase 1 ships two; the others register here as they
 * land, and story content may only launch a registered game.
 */
export type AnyGameLogic = GameLogic<unknown, unknown>;

const REGISTRY: Partial<Record<MinigameId, AnyGameLogic>> = {
  world_cup_knockout: worldCupKnockout as unknown as AnyGameLogic,
  group_presentation: groupPresentation as unknown as AnyGameLogic,
};

export const gameLogic = (id: MinigameId): AnyGameLogic | undefined => REGISTRY[id];
export const implementedGames = (): MinigameId[] => Object.keys(REGISTRY) as MinigameId[];
