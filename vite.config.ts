import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const base = process.env.GITHUB_ACTIONS === "true" ? "/ppl-tracker/" : "/";

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "PPL Tracker",
        short_name: "PPL",
        description: "Push pull legs logger with rest timer",
        theme_color: "#0b0f14",
        background_color: "#0b0f14",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        scope: base,
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
});
