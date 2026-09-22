import catalogJson from "../content/catalog/provisional-u11.json";
import { installRecovery } from "./app/recovery";
import { AUTOSAVE_SLOT, newSession, resumeSession, savedSummary, type Session } from "./app/session";
import { APP_NAME, APP_VERSION, BUILD_ID, BUILD_SHA } from "./app/version";
import { FRIEND_ID, PLAYER_ID, type PendingActivity } from "./campaign/campaign";
import { checkpointMatch, fixtureById, pendingMatchRuntime, reportFromRuntime } from "./campaign/match";
import { clubRule } from "./campaign/tryouts";
import { abandonPending, cancelPending, completeCrossbar, completeHomeSkill, completeJuggling, completeMatch, completeTraining, completeTryout, isTired, type Completion } from "./campaign/week";
import { createRuntime } from "./match/runtime";
import { DEFAULT_ACCESSIBILITY, type AccessibilitySettings } from "./minigame/contract";
import type { MinigameSession } from "./minigame/machine";
import { registerServiceWorker } from "./pwa/register";
import { LocalStorageStore, SaveError } from "./save/save";
import { U11_9V9 } from "./sim/rules";
import { generateSquad } from "./sim/squad";
import { ROLE_BY_NUMBER, ROLE_LABEL, ROLE_NUMBERS, type RoleNumber } from "./sim/types";
import { cancelMinigame, checkpointMinigame, completeMinigame, launchMinigame, pendingMinigame } from "./story/episode";
import { continueScene } from "./story/flow";
import { activeLessonCue } from "./story/lesson";
import type { Scene } from "./story/scenes";
import { loadCatalog, type CatalogFile } from "./tactics/catalog";
import { pacingFor } from "./tactics/recognition";
import { JUGGLING_FACTS, recordFirstTouch } from "./training/record";
import { mountCreateScreen } from "./ui/createScreen";
import { mountCrossbarScreen } from "./ui/crossbarScreen";
import { mountDrillScreen } from "./ui/drillScreen";
import { mountHomeSkillScreen } from "./ui/homeSkillScreen";
import { mountHubScreen } from "./ui/hubScreen";
import { mountJugglingScreen } from "./ui/jugglingScreen";
import { mountMatchScreen } from "./ui/matchScreen";
import { mountMinigameScreen } from "./ui/minigameScreen";
import { mountSceneScreen } from "./ui/sceneScreen";
import { mountSmallSidedScreen } from "./ui/smallSidedScreen";
import { mountStartScreen } from "./ui/startScreen";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app root missing");
document.documentElement.dataset["build"] = BUILD_SHA;

const catalog = loadCatalog(catalogJson as CatalogFile);
const store = new LocalStorageStore();

// ------------------------------------------------------------------ campaign

function showStart(): void {
  mountStartScreen(root!, savedSummary(store), {
    onContinue: () => {
      try {
        const s = resumeSession(store);
        if (s) showCampaign(s);
        else showStart();
      } catch (e) {
        if (!(e instanceof SaveError)) throw e;
        window.alert(`This save can't be loaded (${e.code}). It has been left in place.`);
        showStart();
      }
    },
    onNew: () => showCreate(),
    onQuickMatch: () => showQuickMatch(),
  });
}

function showCreate(): void {
  mountCreateScreen(root!, {
    onCreate: (r) => {
      store.remove(AUTOSAVE_SLOT);
      showCampaign(newSession(store, { kind: r.kind, player: r.player }));
    },
    onBack: showStart,
  });
}

/** Whatever the campaign is doing now: a minigame in progress, the current scene, or the hub between scenes. */
function showCampaign(s: Session): void {
  const pending = pendingMinigame(s.campaign);
  if (pending) {
    showMinigame(s, pending.session);
    return;
  }
  if (s.campaign.scene) {
    mountSceneScreen(root!, s, {
      onNext: () => showCampaign(s),
      onActivity: (scene) => showActivity(s, scene),
      onMinigame: () => showMinigame(s, launchMinigame(s.campaign, s.scenes, loadAccessibility())),
    });
    return;
  }
  mountHubScreen(root!, s, { onScene: () => showCampaign(s), onLaunch: (p) => showPending(s, p), onExit: showStart });
}

const nameOf = (s: Session, id: string, fallback: string): string => s.campaign.roster.people.find((p) => p.id === id)?.name ?? fallback;

const hashId = (id: string): number => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** Run the playable activity the week module launched; its `complete*` moves the calendar, evidence and story. */
function showPending(s: Session, p: PendingActivity): void {
  const c = s.campaign;
  const after = (_: Completion): void => {
    s.save();
    showCampaign(s);
  };
  switch (p.kind) {
    case "training": {
      const myClub = c.roster.people.find((y) => y.id === PLAYER_ID)?.clubId ?? null;
      const teammates = c.roster.people.filter((x) => x.id !== PLAYER_ID && x.role === "player" && x.clubId === myClub);
      const friendFirst = [...teammates].sort((a, b) => (a.id === FRIEND_ID ? -1 : b.id === FRIEND_ID ? 1 : 0));
      mountSmallSidedScreen(root!, {
        activity: p.activity,
        seed: c.seed ^ (c.day * 31),
        names: { user: c.player.name, teammates: friendFirst.slice(0, 3).map((x) => x.name) },
        coachName: nameOf(s, "coach", "Coach"),
        windowScale: isTired(c) ? 0.7 : 1,
        onDone: (summary) => after(completeTraining(c, summary)),
        onQuit: () => {
          abandonPending(c);
          s.save();
          showCampaign(s);
        },
      });
      return;
    }
    case "tryout": {
      const recruiter = clubRule(p.clubId)?.recruiter;
      mountSmallSidedScreen(root!, {
        activity: p.activity,
        seed: c.seed ^ (c.day * 31) ^ hashId(p.clubId),
        names: { user: c.player.name, teammates: ["Trialist 7", "Trialist 12"] },
        coachName: recruiter ? nameOf(s, recruiter, "Coach") : "Coach",
        windowScale: isTired(c) ? 0.7 : 1,
        onDone: (summary) => after(completeTryout(c, summary)),
        onQuit: () => {
          cancelPending(c);
          s.save();
          showCampaign(s);
        },
      });
      return;
    }
    case "crossbar":
      mountCrossbarScreen(root!, {
        seed: c.seed ^ (c.day * 17),
        friendName: nameOf(s, FRIEND_ID, "Friend"),
        onDone: (summary) => after(completeCrossbar(c, summary)),
      });
      return;
    case "juggling": {
      const best = c.story.facts[JUGGLING_FACTS.best];
      mountJugglingScreen(root!, {
        seed: c.seed ^ (c.day * 23),
        previousBest: typeof best === "number" ? best : 0,
        onDone: (summary) => after(completeJuggling(c, summary)),
        onQuit: () => {
          cancelPending(c);
          s.save();
          showCampaign(s);
        },
      });
      return;
    }
    case "home_skill":
      mountHomeSkillScreen(root!, {
        campaign: c,
        assignmentId: p.assignmentId,
        coachName: nameOf(s, "coach", "Coach"),
        onDone: (effects) => after(completeHomeSkill(c, effects)),
        onBack: () => {
          cancelPending(c);
          s.save();
          showCampaign(s);
        },
      });
      return;
    case "match": {
      const fixture = fixtureById(c, p.fixtureId);
      const runtime = pendingMatchRuntime(c, fixture, catalog, pacingFor(ROLE_BY_NUMBER[c.player.position]));
      const lesson = activeLessonCue(c.story.facts, ROLE_BY_NUMBER[c.player.position]);
      mountMatchScreen(
        root!,
        runtime,
        (rt) => after(completeMatch(c, reportFromRuntime(rt, fixture))),
        {
          exitLabel: "Back to the week",
          ...(lesson ? { lesson } : {}),
          onSave: (save) => {
            checkpointMatch(c, save);
            s.save();
            showCampaign(s);
          },
        },
      );
      return;
    }
  }
}

// ------------------------------------------------------------------ minigames

const A11Y_KEY = "soccermaster.minigame.a11y";

function loadAccessibility(): AccessibilitySettings {
  const base: AccessibilitySettings = {
    ...DEFAULT_ACCESSIBILITY,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
  try {
    const raw = localStorage.getItem(A11Y_KEY);
    if (!raw) return base;
    const v = JSON.parse(raw) as Partial<AccessibilitySettings>;
    return {
      reducedMotion: typeof v.reducedMotion === "boolean" ? v.reducedMotion : base.reducedMotion,
      highContrast: v.highContrast === true,
      timerScale: v.timerScale === 2 || v.timerScale === 1.5 ? v.timerScale : 1,
      assist: v.assist === true,
    };
  } catch {
    return base;
  }
}

function saveAccessibility(a: AccessibilitySettings): void {
  try {
    localStorage.setItem(A11Y_KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable: settings live for this session only */
  }
}

/**
 * A story-launched minigame. The session is checkpointed into the campaign save at every round
 * boundary and pause, and committed through `completeMinigame` exactly once when it ends; the
 * scene only continues after that commit.
 */
function showMinigame(s: Session, session: MinigameSession<unknown, unknown>): void {
  const c = s.campaign;
  const names = Object.fromEntries(c.roster.people.map((p) => [p.id, p.name]));
  mountMinigameScreen(root!, {
    session,
    names,
    onAccessibility: saveAccessibility,
    onCheckpoint: (sess) => {
      checkpointMinigame(c, sess);
      s.save();
    },
    onDone: (sess) => {
      if (sess.phase === "start") {
        cancelMinigame(c);
      } else {
        const r = completeMinigame(c, s.scenes, sess);
        if (!r.ok) {
          console.error(`minigame result not committed: ${r.reason}`);
          cancelMinigame(c);
        }
      }
      s.save();
      showCampaign(s);
    },
  });
}

/** A scene's playable activity. At the park the friend runs the session, not the coach. */
function showActivity(s: Session, scene: Scene): void {
  if (scene.activity !== "first_touch") throw new Error(`unknown activity ${scene.activity}`);
  const c = s.campaign;
  const lead = scene.location === "park" ? nameOf(s, FRIEND_ID, "Friend") : nameOf(s, "coach", "Coach");
  mountDrillScreen(root!, {
    seed: c.seed ^ c.day,
    coachName: lead,
    onDone: (summary) => {
      recordFirstTouch(c, summary, scene.location === "park" ? "park" : "visit");
      continueScene(c, s.scenes);
      s.save();
      showCampaign(s);
    },
  });
}

// --------------------------------------------------------------- quick match

function showQuickMatch(): void {
  root!.className = "";
  root!.innerHTML = `
    <section class="start">
      <h1>${APP_NAME}</h1>
      <p>Build ${APP_VERSION} · ${BUILD_ID} — quick match (debug).</p>
      <div class="card">
        <h2>Quick match</h2>
        <p class="muted">Pick the position you'll play. It stays locked for the whole match; the rest of the team is AI.</p>
        <div class="roles">
          ${ROLE_NUMBERS.map((n) => `<button type="button" class="role" data-role="${n}"><b>${n}</b><span>${ROLE_LABEL[n]}</span></button>`).join("")}
        </div>
        <label class="seed">Seed <input type="number" value="${Math.floor(Math.random() * 1000)}" min="0" step="1" /></label>
        <p class="muted small">U11 9v9 · provisional rules and tactical content, not coach-reviewed.</p>
        <div class="actions"><button type="button" class="link back">Back</button></div>
      </div>
    </section>`;
  const seedInput = root!.querySelector<HTMLInputElement>(".seed input");
  for (const b of root!.querySelectorAll<HTMLButtonElement>("button.role")) {
    b.addEventListener("click", () => {
      const role = Number(b.dataset["role"]) as RoleNumber;
      const seed = Number(seedInput?.value ?? 1) || 1;
      startMatch(seed, role);
    });
  }
  root!.querySelector<HTMLButtonElement>("button.back")?.addEventListener("click", showStart);
}

function startMatch(seed: number, role: RoleNumber): void {
  const home = generateSquad(seed * 7 + 1, "H", 55);
  const away = generateSquad(seed * 7 + 2, "A", 55);
  const me = home.find((p) => p.role === role);
  if (!me) throw new Error("role missing from squad");
  const runtime = createRuntime(
    {
      matchId: `quick-${seed}-${role}`,
      seed,
      rules: U11_9V9,
      home: { side: "home", name: "Riverside FC", shortName: "RIV", squad: home },
      away: { side: "away", name: "Hillcrest United", shortName: "HIL", squad: away },
      controlled: { side: "home", playerId: me.id },
    },
    catalog,
    { pacing: pacingFor(ROLE_BY_NUMBER[role]) },
  );
  mountMatchScreen(root!, runtime, showQuickMatch);
}

installRecovery(root, { onRestart: showStart });
registerServiceWorker();
showStart();
document.documentElement.classList.add("booted");
