import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const raiz = (ruta: string) => fileURLToPath(new URL(ruta, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": raiz("./src"),
      // Permite importar módulos marcados con `server-only` en pruebas de servidor.
      "server-only": raiz("./tests/stubs/server-only.ts"),
    },
  },
  test: {
    // Por omisión, Node; las pruebas de componentes declaran `@vitest-environment jsdom`.
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Exporta la URL y las llaves del Supabase LOCAL a process.env (ver el archivo).
    globalSetup: ["./tests/global-setup.ts"],
    // `forbidden()` de Next exige `experimental.authInterrupts` (next.config.ts); en la
    // compilación Next define esta variable y en las pruebas se define aquí.
    env: { __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: "true" },
  },
});
