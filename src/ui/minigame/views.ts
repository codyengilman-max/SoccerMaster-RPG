import type { MinigameId, MinigameResult } from "../../minigame/contract";
import type { MinigameSession } from "../../minigame/machine";
import type { AnyGameLogic } from "../../minigame/registry";
import { presentationView } from "./presentationView";
import { wckView } from "./wckView";

/** One gamepad sample per frame: stick/d-pad axis in [-1, 1], buttons that went down this frame, and the held set. */
export interface PadFrame {
  x: number;
  y: number;
  pressed: number[];
  held: boolean[];
}

/** What the shell gives a game view: the live session, a typed input sink and the shared HUD surfaces. */
export interface ViewHost {
  session: MinigameSession<unknown, unknown>;
  logic: AnyGameLogic;
  names: Record<string, string>;
  readonly reducedMotion: boolean;
  send(input: unknown): void;
  /** One-line instruction under the stage (what to do right now). */
  prompt(text: string): void;
  /** Short status in the HUD (strikes, round, phase). */
  status(text: string): void;
  /** Big touch buttons under the stage; re-rendered only when the set changes. */
  actions(buttons: { id: string; label: string; key?: string; primary?: boolean }[], onPick: (id: string) => void): void;
}

export interface GameView {
  /** Bullet points for the start card. */
  howTo: string[];
  /** Label of the game-specific assist toggle. */
  assistLabel: string;
  /** Shown before a voluntary exit. */
  leaveWarning: string;
  mount(stage: HTMLElement): void;
  /** Called every frame (also while paused) with the frame delta. */
  render(dtMs: number): void;
  /** Called while active before the machine ticks (continuous keyboard movement). */
  beforeTick?(dtMs: number): void;
  /** Return true when the key was consumed. */
  onKey(e: KeyboardEvent): boolean;
  onKeyUp?(e: KeyboardEvent): void;
  onPad(pad: PadFrame, dtMs: number): void;
  resultHtml(r: MinigameResult): string;
  destroy(): void;
}

export const GAME_VIEWS: Partial<Record<MinigameId, (host: ViewHost) => GameView>> = {
  world_cup_knockout: wckView,
  group_presentation: presentationView,
};
