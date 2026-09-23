import "./style.css";
import { mountApp } from "./ui/app";
import { registerPwa } from "./pwa";

const app = document.querySelector<HTMLElement>("#app");
if (app) mountApp(app);
registerPwa();
