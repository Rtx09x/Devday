import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
function disableExperimental3dNetworkFallbacks() {
  const replacements = new Map([
    // @tscircuit/3d-viewer 0.0.577's STEP loader is unreachable through the
    // pane's resolver, but its prebundled URL strings must not ship dormant.
    [
      "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist",
      "offline:occt-disabled",
    ],
    [
      "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/+esm",
      "offline:occt-disabled",
    ],
    // troika labels use an inlined local font. Disable its unused Unicode CDN
    // fallback too, so unsupported glyphs fail locally instead of networking.
    [
      "https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data",
      "offline:unicode-font-resolver-disabled",
    ],
    ["trying default CDN.", "trying offline-disabled fallback."],
    // The adopted Pipeline 4 solver is local-only. Pipeline 5 is not used, but
    // its self-contained distribution includes a dormant remote HD-cache URL;
    // remove that URL from the shipped bundle so it cannot become a fallback.
    ["https://hd-cache.tscircuit.com", "offline:autorouter-hd-cache-disabled"],
  ]);
  return {
    name: "electronics-offline-3d-viewer",
    renderChunk(code: string) {
      let offlineCode = code;
      for (const [networkValue, offlineValue] of replacements) {
        offlineCode = offlineCode.replaceAll(networkValue, offlineValue);
      }
      return offlineCode === code ? null : { code: offlineCode, map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), disableExperimental3dNetworkFallbacks()],
  worker: {
    format: "es",
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { proxy: { "/api": "http://127.0.0.1:4310" } },
  build: { chunkSizeWarningLimit: 1500 },
});
