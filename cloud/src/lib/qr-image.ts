/**
 * Imagen PNG de un QR: el contenido es solo el número en decimal, como texto plano (es lo que
 * lee el lector). `qrcode` se carga al pedir la imagen para no engordar el resto de la página.
 */
export async function qrDataUrl(code: number): Promise<string> {
  const { toDataURL } = await import("qrcode");
  return toDataURL(String(code), { errorCorrectionLevel: "M", margin: 4, width: 320, type: "image/png" });
}
