"use client";

import { useEffect, useState } from "react";
import { qrDataUrl } from "@/lib/qr-image";

/** Imagen del QR de un código, con el número debajo y la descarga `qr-<code>.png`. */
export default function QrImage({ code }: { code: number }) {
  // El resultado lleva su código: al cambiar `code` no se muestra la imagen del anterior.
  const [resultado, setResultado] = useState<{ code: number; url: string | null } | null>(null);

  useEffect(() => {
    let vigente = true;
    qrDataUrl(code).then(
      (url) => vigente && setResultado({ code, url }),
      () => vigente && setResultado({ code, url: null }),
    );
    return () => {
      vigente = false;
    };
  }, [code]);

  const url = resultado?.code === code ? resultado.url : null;
  const fallo = resultado?.code === code && resultado.url === null;

  return (
    <figure className="grid w-fit justify-items-center gap-3">
      <div className="grid size-80 max-w-full place-items-center rounded-lg border border-line bg-white">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL generado en el navegador
          <img src={url} alt={`Código QR ${code}`} width={320} height={320} className="size-full" />
        ) : fallo ? (
          <p role="alert" className="px-4 text-center text-sm text-danger">
            No se pudo generar la imagen del QR.
          </p>
        ) : (
          <p className="text-sm text-muted">Generando imagen…</p>
        )}
      </div>
      <figcaption className="font-mono text-xl font-semibold tabular-nums tracking-wider">{code}</figcaption>
      {url && (
        <a className="btn-quiet" href={url} download={`qr-${code}.png`}>
          Descargar PNG
        </a>
      )}
    </figure>
  );
}
