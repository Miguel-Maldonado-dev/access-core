/** Aviso tras una acción: error (se anuncia al aparecer) o confirmación. */
export type Notice = { kind: "error" | "ok"; text: string } | null;

/**
 * Zona de avisos de una página de gestión. El contenedor `role="status"` existe siempre
 * (vacío no ocupa espacio) para que los lectores de pantalla anuncien las confirmaciones;
 * los errores van en `role="alert"`.
 */
export default function Notices({ notice }: { notice: Notice }) {
  return (
    <>
      {notice?.kind === "error" && (
        <p role="alert" className="notice-error">
          {notice.text}
        </p>
      )}
      <p role="status" className="notice-ok">
        {notice?.kind === "ok" ? notice.text : ""}
      </p>
    </>
  );
}
