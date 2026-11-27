"use client";

import { useEffect, useState } from "react";
import { qrDataUrl } from "@/lib/qr";

/** Imagen del QR con su número debajo y descarga en PNG. */
export default function QrImage({ code }: { code: number }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let ignore = false;
    qrDataUrl(code).then(
      (u) => !ignore && setUrl(u),
      () => !ignore && setFailed(true),
    );
    return () => {
      ignore = true;
    };
  }, [code]);

  return (
    <figure className="grid w-fit justify-items-center gap-2">
      {failed ? (
        <p role="alert" className="text-sm font-medium text-danger">
          No se pudo generar la imagen del QR.
        </p>
      ) : url === "" ? (
        <div className="h-40 w-40 rounded border border-line bg-paper" aria-hidden />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- data URL local, no hay nada que optimizar
        <img src={url} alt={`Código QR ${code}`} width={160} height={160} className="rounded border border-line bg-white" />
      )}
      <figcaption className="text-lg font-semibold tabular-nums">{code}</figcaption>
      {url !== "" && (
        <a className="btn-quiet text-sm font-medium" href={url} download={`qr-${code}.png`}>
          Descargar PNG
        </a>
      )}
    </figure>
  );
}
