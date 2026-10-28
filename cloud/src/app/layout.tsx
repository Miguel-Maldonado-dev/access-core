import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Access Core", template: "%s | Access Core" },
  description: "Plataforma en la nube de control de acceso",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
