import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.ORBICORE_WEB_PORT ?? 41750),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.ORBICORE_API_PORT ?? 41751}`,
        configure: (proxy) => proxy.on("proxyReq", (proxyRequest, request) => {
          if (request.headers.host) proxyRequest.setHeader("x-forwarded-host", request.headers.host);
        }),
      },
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
