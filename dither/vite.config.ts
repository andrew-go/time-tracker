import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Builds the dither island into one ES module + one stylesheet that the plain-JS
// app loads on demand from vendor/dither/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "../vendor/dither",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: true,
    // Library builds keep whitespace by default; this file ships to browsers as is.
    rolldownOptions: { output: { minify: true } },
    lib: {
      entry: fileURLToPath(new URL("./src/island.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "dither.js",
      cssFileName: "dither",
    },
  },
});
