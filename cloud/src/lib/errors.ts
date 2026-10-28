/**
 * Error con estado HTTP y mensaje en español apto para mostrarse al usuario.
 * Lo lanzan las guardas y la lógica de servidor; las server actions y las rutas lo
 * traducen a su respuesta (los demás errores se tratan como internos).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
