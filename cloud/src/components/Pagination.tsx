import Link from "next/link";

interface Props {
  page: number;
  pageSize: number;
  total: number;
  /** URL de una página (conserva los filtros). */
  hrefFor: (page: number) => string;
}

/** Paginación por enlaces (la página va en la URL): rango visible, Anterior y Siguiente. */
export default function Pagination({ page, pageSize, total, hrefFor }: Props) {
  if (total === 0) return null;
  const ultima = Math.ceil(total / pageSize);
  if (page > ultima) {
    return (
      <p className="text-sm text-muted">
        Esta página ya no tiene registros.{" "}
        <Link href={hrefFor(ultima)} className="link-action">
          Ir a la última página
        </Link>
      </p>
    );
  }
  const desde = (page - 1) * pageSize + 1;
  const hasta = Math.min(page * pageSize, total);
  return (
    <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="tabular-nums text-muted">
        {desde}–{hasta} de {total}
      </span>
      <span className="flex gap-4">
        {page > 1 && (
          <Link href={hrefFor(page - 1)} className="link-action" rel="prev">
            Anterior
          </Link>
        )}
        {page < ultima && (
          <Link href={hrefFor(page + 1)} className="link-action" rel="next">
            Siguiente
          </Link>
        )}
      </span>
    </nav>
  );
}
