import catalogJson from "../content/catalog/provisional-u11.json";
import { AUTOSAVE_SLOT, newSession, resumeSession, savedSummary, type Session } from "./app/session";
import { APP_NAME, APP_VERSION } from "./app/version";
import { createRuntime } from "./match/runtime";
import { LocalStorageStore, SaveError } from "./save/save";
import { U11_9V9 } from "./sim/rules";
import { generateSquad } from "./sim/squad";
import { ROLE_BY_NUMBER, ROLE_LABEL, ROLE_NUMBERS, type RoleNumber } from "./sim/types";
import { continueScene } from "./story/flow";
import { loadCatalog, type CatalogFile } from "./tactics/catalog";
import { pacingFor } from "./tactics/recognition";
import { recordFirstTouch } from "./training/record";
import { mountCreateScreen } from "./ui/createScreen";
import { mountDrillScreen } from "./ui/drillScreen";
import { mountHubScreen } from "./ui/hubScreen";
import { mountMatchScreen } from "./ui/matchScreen";
import { mountSceneScreen } from "./ui/sceneScreen";
import { mountStartScreen } from "./ui/startScreen";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app root missing");

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

/** Whatever the campaign is doing now: the current scene, or the hub between scenes. */
function showCampaign(s: Session): void {
  if (s.campaign.scene) {
    mountSceneScreen(root!, s, {
      onNext: () => showCampaign(s),
      onActivity: (scene) => showActivity(s, scene.activity!),
    });
    return;
  }
  mountHubScreen(root!, s, { onScene: () => showCampaign(s), onExit: showStart });
}

function showActivity(s: Session, activityId: string): void {
  if (activityId !== "first_touch") throw new Error(`unknown activity ${activityId}`);
  const c = s.campaign;
  const coach = c.roster.people.find((p) => p.id === "coach")?.name ?? "Coach";
  mountDrillScreen(root!, {
    seed: c.seed ^ c.day,
    coachName: coach,
    onDone: (summary) => {
      recordFirstTouch(c, summary);
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
      <p>Build ${APP_VERSION} — quick match (debug).</p>
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

showStart();
