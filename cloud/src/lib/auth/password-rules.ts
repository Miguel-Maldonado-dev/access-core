/**
 * Límites de la contraseña. Módulo sin `server-only` para que los formularios del
 * navegador (maxLength) y el servidor (validación) usen los mismos números.
 */
export const MIN_PASSWORD_LENGTH = 8;
/** Máximo que admite Auth: bcrypt solo lee los primeros 72 bytes. */
export const MAX_PASSWORD_LENGTH = 72;
