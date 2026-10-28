"use client";

import OutputForm from "@/components/access/OutputForm";
import type { ActionResult } from "@/lib/actions";
import type { OutputInput, OutputRow } from "@/lib/outputs";
import type { PanelOption } from "@/lib/profile-view";

interface Props {
  panels: PanelOption[];
  outputs: OutputRow[];
  onSave: (outputId: string, input: OutputInput) => Promise<ActionResult>;
}

/** Pestaña Salidas: las 4 salidas de cada panel (S1–S4), con alias. No se crean ni se borran aquí. */
export default function OutputsManager({ panels, outputs, onSave }: Props) {
  return (
    <div className="grid grid-cols-1 gap-8">
      <h2 className="text-lg font-semibold">Salidas</h2>
      {panels.length === 0 && (
        <p className="text-muted">Esta instalación aún no tiene paneles. Vincula uno en la pestaña Paneles.</p>
      )}
      {panels.map((p) => {
        const salidas = outputs.filter((o) => o.panel_id === p.id).sort((a, b) => a.output_index - b.output_index);
        return (
          <section key={p.id} aria-labelledby={`salidas-${p.id}`} className="grid gap-4">
            <h3 id={`salidas-${p.id}`} className="font-mono text-base font-semibold">
              {p.panel_code}
            </h3>
            {salidas.length === 0 ? (
              <p className="text-muted">Este panel aún no tiene salidas: se crean al confirmar su importación.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {salidas.map((o) => (
                  <OutputForm key={o.id} panelCode={p.panel_code} output={o} onSave={onSave} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
