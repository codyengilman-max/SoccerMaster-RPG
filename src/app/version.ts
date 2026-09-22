export const APP_NAME = "SoccerMaster RPG";
export const APP_VERSION = "0.0.1";

/** Injected by vite `define` at build time; absent under plain tsx / vitest. */
declare const __BUILD_SHA__: string;
/** Full commit SHA the bundle was built from ("dev" outside a vite build). */
export const BUILD_SHA: string = typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "dev";
/** Short form shown on screens: the first seven characters of the commit. */
export const BUILD_ID = BUILD_SHA.slice(0, 7);
