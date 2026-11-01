import { mountGoodFieldBrowserApp } from "./browser-app.ts";
import { installSoundControls } from "./sound-control.ts";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("GoodField application root was not found");
}

installSoundControls(document);

const app = mountGoodFieldBrowserApp(root);
await app.restore();
