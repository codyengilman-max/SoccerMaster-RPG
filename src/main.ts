import { APP_NAME, APP_VERSION } from "./app/version";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app root missing");

root.innerHTML = `
  <section class="start">
    <h1>${APP_NAME}</h1>
    <p>Build ${APP_VERSION} — first playable milestone in progress.</p>
  </section>
`;
