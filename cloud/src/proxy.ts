import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy de sesión (Next 16; antes `middleware.ts`). En cada página:
 *  - refresca la sesión de Supabase Auth (`getClaims()` verifica el JWT y, si venció,
 *    lo renueva) y pasa las cookies nuevas a los Server Components y al navegador;
 *  - lleva a /login, con la ruta de regreso en `next`, a quien no tenga sesión, salvo en
 *    las rutas públicas de acceso (/login y /auth/*);
 *  - lleva al inicio a quien ya tiene sesión y abre /login.
 * No corre en /api/* (dispositivos, MQTT, avisos internos y salud tienen su propia
 * autenticación) ni en estáticos. Es solo la primera barrera: cada página, server action
 * y ruta comprueba sesión y rol por su cuenta (`src/lib/auth/guards.ts`).
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/api" || pathname.startsWith("/api/")) return NextResponse.next();

  let respuesta = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          respuesta = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => respuesta.cookies.set(name, value, options));
          // Sin caché en CDN para respuestas que escriben la sesión.
          Object.entries(headers).forEach(([clave, valor]) => respuesta.headers.set(clave, valor));
        },
      },
    },
  );

  // Nada entre createServerClient y getClaims(): es lo que refresca la sesión.
  const { data } = await supabase.auth.getClaims();
  const conSesion = Boolean(data?.claims?.sub);

  const publica = pathname === "/login" || pathname.startsWith("/auth/");
  if (!conSesion && !publica) {
    const destino = new URL("/login", request.url);
    if (pathname !== "/") destino.searchParams.set("next", pathname + search);
    return redirigir(destino, respuesta);
  }
  if (conSesion && pathname === "/login") {
    return redirigir(new URL("/", request.url), respuesta);
  }
  return respuesta;
}

/** Redirección que conserva las cookies y encabezados que dejó el refresco de la sesión. */
function redirigir(url: URL, respuesta: NextResponse): NextResponse {
  const redireccion = NextResponse.redirect(url);
  respuesta.cookies.getAll().forEach((cookie) => redireccion.cookies.set(cookie));
  for (const clave of ["cache-control", "expires", "pragma"]) {
    const valor = respuesta.headers.get(clave);
    if (valor) redireccion.headers.set(clave, valor);
  }
  return redireccion;
}

export const config = {
  matcher: [
    // Todo salvo /api/*, estáticos de Next, el favicon e imágenes.
    "/((?!api/|api$|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
