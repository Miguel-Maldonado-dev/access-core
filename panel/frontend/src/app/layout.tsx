import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control de acceso",
  description: "Panel de administración del control de acceso",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
