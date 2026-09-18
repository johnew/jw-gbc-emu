import "./style.css";
import { mountApp } from "./ui/app";

const app = document.querySelector<HTMLElement>("#app");
if (app) mountApp(app);
