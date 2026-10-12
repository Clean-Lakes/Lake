import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: process.env.LAKE_DEV_BACKEND_URL || "http://127.0.0.1:4177", changeOrigin: true } },
  },
});
