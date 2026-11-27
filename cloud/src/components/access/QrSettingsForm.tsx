"use client";

import { useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import { QR_DIGIT_MESSAGE, QR_MAX_ACTIVE, QR_MAX_ACTIVE_MESSAGE } from "@/lib/qr-view";

export interface QrSettingsValue {
  digit: number;
  max_active: number;
}

interface Props {
  settings: QrSettingsValue;
  /** Solo el admin edita; el técnico los ve en solo lectura. */
  canEdit: boolean;
  onSave: (settings: QrSettingsValue) => Promise<ActionResult>;
}

const entero = (texto: string) => (/^\d+$/.test(texto.trim()) ? Number(texto) : Number.NaN);

/** Ajustes de QR de la instalación: dígito con el que empiezan los códigos y tope de QR vigentes. */
export default function QrSettingsForm({ settings, canEdit, onSave }: Props) {
  const [digit, setDigit] = useState(String(settings.digit));
  const [maxActive, setMaxActive] = useState(String(settings.max_active));
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  function guardar(e: FormEvent) {
    e.preventDefault();
    const d = entero(digit);
    const m = entero(maxActive);
    if (!Number.isInteger(d) || d < 1 || d > 9) return setNotice({ kind: "error", text: QR_DIGIT_MESSAGE });
    if (!Number.isInteger(m) || m < 1 || m > QR_MAX_ACTIVE) return setNotice({ kind: "error", text: QR_MAX_ACTIVE_MESSAGE });
    setNotice(null);
    startTransition(async () => {
      const r = await onSave({ digit: d, max_active: m });
      setNotice(r.ok ? { kind: "ok", text: "Se guardaron los ajustes de QR." } : { kind: "error", text: r.error });
    });
  }

  return (
    <form aria-labelledby="qr-ajustes" noValidate onSubmit={guardar} className="grid max-w-2xl gap-4 rounded-lg border border-line bg-paper p-4">
      <div className="grid gap-1">
        <h3 id="qr-ajustes" className="text-base font-semibold">
          Ajustes de QR
        </h3>
        <p className="text-sm text-muted">
          Cambiar el dígito solo afecta a los QR nuevos; los ya emitidos siguen valiendo.
          {!canEdit && " Solo un administrador puede cambiar estos ajustes."}
        </p>
      </div>
      <fieldset disabled={!canEdit || pendiente} className="grid gap-4 border-0 p-0 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Dígito de QR
          <input className="field tabular-nums" type="number" inputMode="numeric" min={1} max={9} value={digit} onChange={(e) => setDigit(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Máximo de QR vigentes
          <input className="field tabular-nums" type="number" inputMode="numeric" min={1} max={QR_MAX_ACTIVE} value={maxActive} onChange={(e) => setMaxActive(e.target.value)} />
        </label>
      </fieldset>
      <Notices notice={notice} />
      {canEdit && (
        <div>
          <button type="submit" className="btn" disabled={pendiente}>
            {pendiente ? "Guardando…" : "Guardar ajustes"}
          </button>
        </div>
      )}
    </form>
  );
}
