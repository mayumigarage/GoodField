import { mountGoodFieldBrowserApp } from "./browser-app.ts";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("GoodField application root was not found");
}

const app = mountGoodFieldBrowserApp(root);
await app.restore();
