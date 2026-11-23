import { defineConfig } from "vite";

// Builds the embeddable SDK as a single self-contained IIFE (no dependency on the host page's React).
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  publicDir: false,
  build: {
    outDir: "dist-widget",
    emptyOutDir: true,
    target: "es2020",
    lib: { entry: "packages/widget/src/index.tsx", name: "UtilmoAIWidget", formats: ["iife"], fileName: () => "widget.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
    minify: true,
    sourcemap: false,
  },
});
