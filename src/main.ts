import catalogJson from "../content/catalog/provisional-u11.json";
import { APP_NAME, APP_VERSION } from "./app/version";
import { createRuntime } from "./match/runtime";
import { U11_9V9 } from "./sim/rules";
import { generateSquad } from "./sim/squad";
import { ROLE_BY_NUMBER, ROLE_NUMBERS, type RoleNumber } from "./sim/types";
import { loadCatalog, type CatalogFile } from "./tactics/catalog";
import { pacingFor } from "./tactics/recognition";
import { mountMatchScreen } from "./ui/matchScreen";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app root missing");

const catalog = loadCatalog(catalogJson as CatalogFile);

const ROLE_LABEL: Record<RoleNumber, string> = {
  1: "Goalkeeper",
  2: "Right back",
  3: "Left back",
  4: "Centre back",
  6: "Defensive mid",
  8: "Central mid",
  7: "Right winger",
  9: "Striker",
  11: "Left winger",
};

function showStart(): void {
  root!.innerHTML = `
    <section class="start">
      <h1>${APP_NAME}</h1>
      <p>Build ${APP_VERSION} — first playable milestone in progress.</p>
      <div class="card">
        <h2>Quick match</h2>
        <p class="muted">Pick the position you'll play. It stays locked for the whole match; the rest of the team is AI.</p>
        <div class="roles">
          ${ROLE_NUMBERS.map((n) => `<button type="button" class="role" data-role="${n}"><b>${n}</b><span>${ROLE_LABEL[n]}</span></button>`).join("")}
        </div>
        <label class="seed">Seed <input type="number" value="${Math.floor(Math.random() * 1000)}" min="0" step="1" /></label>
        <p class="muted small">U11 9v9 · provisional rules and tactical content, not coach-reviewed.</p>
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
  mountMatchScreen(root!, runtime, showStart);
}

showStart();
