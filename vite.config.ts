import { fileURLToPath } from "node:url";
import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8099";

export const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    stylex.vite({
      devMode: "full",
      useCSSLayers: true,
      // StyleX resolves `defineVars` imports itself, so it needs the same path alias Vite has.
      aliases: { "@/*": ["/ROOT/src/*"] },
      unstable_moduleResolution: { type: "commonJS", rootDir: projectRoot },
    }),
    react(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: Number(process.env.PORT ?? 5273),
    host: "127.0.0.1",
    proxy: {
      // VITE_API_BASE=/api-proxy in dev: strip the prefix and forward to the real
      // backend (kubectl port-forward during development, the automator pod in prod).
      "/api-proxy": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
