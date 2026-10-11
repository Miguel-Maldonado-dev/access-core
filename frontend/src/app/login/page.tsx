"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api";

const field =
  "mt-1 block w-full rounded border border-line bg-surface px-3 py-2 text-base text-text";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navegación completa a propósito
      window.location.assign("/titulares/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión");
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen md:grid-cols-[1fr_28rem]">
      <section className="hidden flex-col justify-between bg-ink p-12 text-white md:flex">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
          <rect x="6" y="6" width="44" height="44" rx="6" stroke="#5fd1b8" strokeWidth="3" />
          <circle cx="28" cy="28" r="7" fill="#5fd1b8" />
          <path d="M28 35v9" stroke="#5fd1b8" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div>
          <h1 className="text-5xl font-semibold tracking-tight">Control de acceso</h1>
          <p className="mt-4 max-w-md text-lg text-white/70">
            Titulares, tarjetas, controles y registro de entradas del fraccionamiento.
          </p>
        </div>
      </section>
      <section className="flex items-center bg-surface p-8">
        <form onSubmit={submit} className="w-full" noValidate>
          <h2 className="text-2xl font-semibold">Iniciar sesión</h2>
          <label className="mt-6 block text-sm font-medium">
            Usuario
            <input
              className={field}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="mt-4 block text-sm font-medium">
            Contraseña
            <input
              className={field}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error !== "" && (
            <p role="alert" className="mt-4 text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-6 w-full rounded bg-signal px-4 py-2.5 font-medium text-white hover:bg-signal-strong disabled:opacity-60"
          >
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </section>
    </main>
  );
}
