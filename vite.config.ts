import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
});
