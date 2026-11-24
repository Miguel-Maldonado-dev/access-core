"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { useSyncExternalStore } from "react";

/**
 * Visor interactivo de la API (Scalar), sin recursos externos: sin fuentes remotas, sin proxy
 * de scalar.com, sin telemetría ni agente/MCP. "Probar" llama a este mismo origen con la llave
 * que el usuario pega; `persistAuth: false` evita guardarla en localStorage (queda solo en
 * memoria mientras la pestaña esté abierta). Scalar sí guarda en localStorage sus ajustes
 * de interfaz (tema, barra lateral), nunca la llave.
 */

/** Colores de la app (src/app/globals.css) sobre las variables de Scalar. */
const CSS = `
.light-mode {
  --scalar-color-1: #15232b;
  --scalar-color-2: #55676f;
  --scalar-color-3: #55676f;
  --scalar-color-accent: #0a6f5c;
  --scalar-background-1: #ffffff;
  --scalar-background-2: #eef2f4;
  --scalar-background-3: #e3e9ec;
  --scalar-background-accent: #e1f1ed;
  --scalar-border-color: #d3dce1;
  --scalar-button-1: #0a6f5c;
  --scalar-button-1-hover: #07584a;
  --scalar-button-1-color: #ffffff;
}
.dark-mode {
  --scalar-color-1: #e8eef1;
  --scalar-color-2: #a9bac2;
  --scalar-color-3: #a9bac2;
  --scalar-color-accent: #5fd1b8;
  --scalar-background-1: #12222b;
  --scalar-background-2: #1c3340;
  --scalar-background-3: #244253;
  --scalar-background-accent: #1c3340;
  --scalar-border-color: #2c4857;
  --scalar-button-1: #5fd1b8;
  --scalar-button-1-hover: #8ae0cc;
  --scalar-button-1-color: #12222b;
}
`;

const nada = () => () => {};
const origen = () => window.location.origin;
const sinOrigen = () => null;

export default function ApiReference({ spec }: { spec: object }) {
  const base = useSyncExternalStore(nada, origen, sinOrigen);
  if (!base) return <p className="p-6 text-muted">Cargando la documentación…</p>;

  return (
    <ApiReferenceReact
      configuration={{
        content: spec as Record<string, unknown>,
        // Las llamadas de "Probar" van al mismo origen, sin proxy.
        servers: [{ url: `${base}/api/v1`, description: "Esta nube" }],
        proxyUrl: undefined,
        persistAuth: false,
        authentication: { preferredSecurityScheme: "bearerAuth" },
        withDefaultFonts: false,
        telemetry: false,
        mcp: { disabled: true },
        agent: { disabled: true },
        hideClientButton: true,
        showDeveloperTools: "never",
        theme: "default",
        layout: "modern",
        customCss: CSS,
        metaData: { title: "Documentación de la API" },
      }}
    />
  );
}
