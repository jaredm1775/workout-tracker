import { registerSW } from "virtual:pwa-register";
import { startApp } from "./app";

registerSW({ immediate: true });
void startApp();
