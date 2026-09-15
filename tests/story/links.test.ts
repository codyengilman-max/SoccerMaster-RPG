import { describe, expect, it } from "vitest";
import { campaignScenes } from "../../src/story/flow";
import type { Scene } from "../../src/story/scenes";

/**
 * A dangling scene link (`next`, a choice's `next`, a `queue_scene` effect) throws `unknown scene`
 * the moment the player reaches it, which leaves the screen dead mid-story. Every link in the
 * authored content must resolve for both campaigns.
 */
function links(scene: Scene): Array<{ where: string; id: string }> {
  const out: Array<{ where: string; id: string }> = [];
  if (scene.next) out.push({ where: `${scene.id}.next`, id: scene.next });
  for (const ch of scene.choices) {
    if (ch.next) out.push({ where: `${scene.id}/${ch.id}.next`, id: ch.next });
    const effects = [...ch.immediate, ...ch.delayed.flatMap((d) => d.effects), ...ch.repair.flatMap((r) => r.effects)];
    for (const e of effects) {
      if (e.type === "queue_scene") out.push({ where: `${scene.id}/${ch.id} queue_scene`, id: e.sceneId });
    }
  }
  return out;
}

describe("story content links", () => {
  for (const kind of ["boys", "girls"] as const) {
    it(`every scene link in the ${kind} campaign resolves`, () => {
      const scenes = campaignScenes(kind);
      const ids = new Set(scenes.map((s) => s.id));
      const dangling = scenes.flatMap(links).filter((l) => !ids.has(l.id));
      expect(dangling).toEqual([]);
      expect(scenes.length).toBe(ids.size);
    });
  }
});
