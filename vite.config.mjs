import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { medical: "index.html", platform: "platform.html" },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } },
  },
});
