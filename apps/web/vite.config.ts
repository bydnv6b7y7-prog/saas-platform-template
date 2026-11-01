import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  server: {
    port: 3001,
    // Extra hosts allowed to reach the dev server, e.g. an HTTPS tunnel that keeps OAuth callbacks
    // and cookies on one origin: VITE_DEV_ALLOWED_HOSTS=dev.example.com,other.example.com
    allowedHosts: loadEnv(mode, process.cwd(), "VITE_DEV_").VITE_DEV_ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    nitro({
      preset: "bun",
      compressPublicAssets: {
        gzip: true,
        brotli: true,
      },
      routeRules: {
        "/assets/**": {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
          },
        },
      },
    }),
    viteReact(),
  ],
}));
