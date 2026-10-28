"use client";

import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-rules";

/** Mensaje si la confirmación no es igual a la contraseña, o `null` si coinciden. */
export function passwordMismatch(password: string, confirmation: string): string | null {
  return password === confirmation ? null : "Las contraseñas no coinciden.";
}

/**
 * Contraseña y su confirmación para dar de alta una cuenta. La longitud mínima la valida el
 * servidor; el navegador solo limita el máximo y no autocompleta contraseñas guardadas.
 */
export default function PasswordFields({
  label,
  confirmationLabel,
  password,
  confirmation,
  onPassword,
  onConfirmation,
}: {
  label: string;
  confirmationLabel: string;
  password: string;
  confirmation: string;
  onPassword: (valor: string) => void;
  onConfirmation: (valor: string) => void;
}) {
  return (
    <>
      <label className="block text-sm font-medium">
        {label}
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="new-password"
          required
        />
      </label>
      <label className="block text-sm font-medium">
        {confirmationLabel}
        <input
          className="field"
          type="password"
          value={confirmation}
          onChange={(e) => onConfirmation(e.target.value)}
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="new-password"
          required
        />
      </label>
    </>
  );
}
