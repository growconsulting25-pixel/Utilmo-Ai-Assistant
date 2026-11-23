import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Demo site + admin dashboard (the widget SDK is built separately by vite.widget.config.ts).
export default defineConfig({
  root: "apps",
  publicDir: resolve(__dirname, "public"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(__dirname, "apps/index.html"), admin: resolve(__dirname, "apps/admin/index.html"), embed: resolve(__dirname, "apps/embed-example.html") } },
  },
  css: { postcss: resolve(__dirname, "postcss.config.cjs") },
});
