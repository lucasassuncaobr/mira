import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: true,
    // COEP/COEP removidos junto com o motor PDFium/wasm: o frontend consome
    // apenas imagens JPEG pré-renderizadas (lazy loading) — sem SharedArrayBuffer.
  },
});
