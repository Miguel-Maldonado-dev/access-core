import BrandMark from "@/components/BrandMark";

/** Páginas de acceso (sin sesión o con el enlace de recuperación): misma composición que el login del panel local. */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="grid min-h-screen md:grid-cols-[1fr_28rem]">
      <section className="hidden flex-col justify-between bg-ink p-12 text-white md:flex">
        <BrandMark size={56} />
        <div>
          <p className="text-5xl font-semibold tracking-tight">Access Core</p>
          <p className="mt-4 max-w-md text-lg text-white/70">
            Instalaciones, paneles y accesos de tus fraccionamientos, desde un solo lugar.
          </p>
        </div>
      </section>
      <section className="flex items-center bg-surface px-4 py-10 sm:px-8">
        <div className="w-full">
          <p className="mb-10 flex items-center gap-2.5 text-lg font-semibold tracking-tight md:hidden">
            <span className="rounded bg-ink p-1.5">
              <BrandMark size={22} />
            </span>
            Access Core
          </p>
          {children}
        </div>
      </section>
    </main>
  );
}
