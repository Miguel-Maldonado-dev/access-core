import QRCode from "qrcode";

/** PNG en data URL con el número del QR como contenido (el lector lo envía como tarjeta). */
export function qrDataUrl(code: number): Promise<string> {
  return QRCode.toDataURL(String(code), { errorCorrectionLevel: "M", margin: 2, width: 320 });
}
