export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* cuerpo vacío o no JSON */
  }
  return `Error ${res.status}`;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(API_BASE + path, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    const onLogin = path === "/api/login" || window.location.pathname.startsWith("/login");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navegación completa a propósito
    if (res.status === 401 && !onLogin) window.location.assign("/login/");
    throw new ApiError(res.status, await errorMessage(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
