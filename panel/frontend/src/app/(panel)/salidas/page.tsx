"use client";

import { useEffect, useState } from "react";
import OutputForm, { type OutputPayload } from "@/components/OutputForm";
import { apiFetch } from "@/lib/api";
import { outputLabel } from "@/lib/format";
import type { Output } from "@/lib/types";

export default function OutputsPage() {
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    apiFetch<Output[]>("/api/outputs").then(setOutputs, (err) =>
      setError(err instanceof Error ? err.message : "Ocurrió un error inesperado."),
    );
  }, []);

  async function save(id: number, payload: OutputPayload) {
    setSaved("");
    try {
      const updated = await apiFetch<Output>(`/api/outputs/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      setOutputs((cur) => cur.map((o) => (o.output_id === id ? updated : o)));
      setError("");
      setSaved(`${outputLabel(id)} guardada.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ocurrió un error inesperado.");
    }
  }

  async function test(id: number) {
    setSaved("");
    try {
      const { detail } = await apiFetch<{ detail: string }>(`/api/outputs/${id}/test`, { method: "POST" });
      setError("");
      setSaved(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ocurrió un error inesperado.");
    }
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Salidas</h1>
      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {saved !== "" && (
        <p role="status" className="text-sm font-medium text-signal">
          {saved}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {outputs.map((o) => (
          <OutputForm key={o.output_id} output={o} onSubmit={(p) => save(o.output_id, p)} onTest={() => test(o.output_id)} />
        ))}
      </div>
    </div>
  );
}
