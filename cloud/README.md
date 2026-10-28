# Access Core: plataforma en la nube

Proyecto Next.js (App Router) con Supabase. Diseño: `docs/superpowers/specs/2026-10-26-plataforma-nube-design.md`; plan de la etapa 1: `docs/superpowers/plans/2026-10-26-plataforma-nube-etapa1.md`.

## Requisitos

- Node 24 y npm.
- Docker en marcha.
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) (2.110 o posterior).

## Instalar

```bash
cd cloud
npm install
cp .env.example .env.local   # y completar los valores
```

## Supabase local

```bash
supabase start      # levanta el stack local (API 54321, base 54322, Studio 54323)
supabase status     # URL y llaves locales
supabase stop       # lo detiene
npm run db:reset    # recrea la base local aplicando las migraciones
```

Las pruebas **solo** usan este Supabase local, nunca el proyecto remoto.

## Variables de entorno

Ver `.env.example`. Las reales van en `.env.local`, que git ignora (el repositorio es público: nunca subas llaves).

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL de Supabase (navegador y servidor) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Llave publicable `sb_publishable_…` (navegador y cliente con sesión) |
| `SUPABASE_SECRET_KEY` | Llave secreta `sb_secret_…`. **Solo servidor**, para `createAdminSupabase()` |
| `PIN_ENC_KEY`, `PIN_LOOKUP_KEY` | Claves de 32 bytes en base64 para cifrar y buscar PIN; genera cada una con `openssl rand -base64 32` |
| `EMQX_API_URL`, `EMQX_API_KEY`, `EMQX_API_SECRET`, `EMQX_WEBHOOK_SECRET` | Broker MQTT |
| `INTERNAL_WEBHOOK_SECRET` | Avisos internos de la base a la aplicación |
| `APP_URL` | URL pública de la aplicación |

Clientes en `src/lib/supabase/`: `createServerSupabase()` (sesión del usuario, servidor), `createBrowserSupabase()` (navegador) y `createAdminSupabase()` (llave secreta, solo servidor; falla en el navegador).

## Pruebas y calidad

```bash
npm test            # Vitest
npm run test:db     # pruebas pgTAP (supabase test db; requiere supabase start)
npm run lint
npm run build
```

### Entorno de las pruebas de integración

`tests/global-setup.ts` borra del entorno de pruebas `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL` y `SUPABASE_LOCAL` (así ninguna prueba llega a un proyecto remoto exportado en el shell) y corre `supabase status -o env`; si el stack local está arriba, exporta esas variables con sus valores locales y `SUPABASE_LOCAL=1`. No lee `.env.local`. Las pruebas de integración llaman a `requireLocalSupabase()` (`tests/helpers/supabase-local.ts`), que falla con un mensaje claro si falta `supabase start`; el mismo archivo crea usuarios en el Auth local e inicia sesión con la llave publicable para probar con RLS real. Las pruebas que no usan Supabase (p. ej. health) funcionan sin el stack.

`@/` apunta a `src/` y `server-only` se sustituye por un módulo vacío en Vitest para poder probar código de servidor.

Las pruebas de componentes (`tests/**/*.test.tsx`) declaran `// @vitest-environment jsdom` y usan Testing Library; las demás corren en Node. `vitest.config.mts` define `__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS` para que `forbidden()` funcione en las pruebas como en la compilación.

## Acceso, roles y altas de cuentas

Interfaz en español con Supabase Auth (correo y contraseña). Nadie se registra solo: las cuentas las crea la aplicación (súper administrador o `admin` del tenant), sin invitaciones ni correos.

| Ruta | Quién | Qué hace |
|---|---|---|
| `/login` | pública | Inicio de sesión; `?next=` vuelve a la página pedida (solo rutas internas) |
| `/auth/recuperar` | pública | "¿Olvidaste tu contraseña?": envía el correo de recuperación (`resetPasswordForEmail`) |
| `/auth/confirm` | pública | Enlace del correo de recuperación. Abrirlo solo muestra "Continuar"; el clic (POST) hace `verifyOtp` con el `token_hash` y deja la sesión iniciada, así un escáner de correo no gasta el enlace |
| `/contrasena` | con sesión | Elegir la contraseña (recuperación) o cambiarla |
| `/` | con sesión | Tenants del usuario y, al súper administrador, acceso a `/admin/tenants` |
| `/admin/tenants` | súper administrador | Alta (con la cuenta de su primer administrador), suspensión, reactivación y alta de más administradores |
| `/t/[tenant]/users` | `admin` del tenant | Miembros: agregar (con su cuenta), cambiar rol y quitar (`[tenant]` es el id del tenant) |

- **Proxy de sesión (`src/proxy.ts`):** refresca la sesión y lleva a `/login` a quien no la tenga. No corre en `/api/*` (dispositivos, MQTT, avisos internos y salud tienen su propia autenticación) ni en estáticos.
- **Guardas (`src/lib/auth/guards.ts`):** `requireUser`, `requirePlatformAdmin` y `requireTenantRole` (401/403). Cada página, server action y ruta las aplica por su cuenta; en páginas, `guardPage` lleva a `/login` o muestra la página 403 (`app/forbidden.tsx`, con `experimental.authInterrupts`).
  - Con Cache Components la página ya envió su estructura estática cuando corre la guarda, así que el estado HTTP de esa página 403 es 200 (con `noindex`); el contenido protegido nunca se genera.
- **Pestañas del tenant:** `src/app/t/[tenant]/sections.ts` (segmento, nombre y rol mínimo). Las páginas nuevas del tenant se agregan ahí.
- **Al menos un administrador:** un trigger en `tenant_members` (migración `tenant_admin_guard`) impide quitar o degradar al último `admin` de un tenant, con el mensaje "El tenant debe tener al menos un administrador." que muestra la interfaz. Borrar el tenant borra sus miembros en cascada. Borrar en Auth al último admin de un tenant vivo también falla: primero nombra a otro admin o borra el tenant.
- **Alta de cuentas (sin invitación):** el alta de tenants, "Agregar administrador" y "Agregar usuario" piden correo, contraseña y confirmación, y usan una sola función (`addMemberWithAccount`, `src/lib/tenants/members.ts`) con `auth.admin` (llave secreta, solo en el servidor). No se envía ningún correo.
  - Correo sin cuenta: se crea el usuario con `email_confirm: true` y esa contraseña, y puede iniciar sesión de inmediato.
  - Cuenta confirmada: solo se crea la membresía; su contraseña no cambia (la interfaz lo avisa).
  - Cuenta sin confirmar (invitación pendiente de antes): se le pone la contraseña dada, se confirma y se crea la membresía.
  - Atomicidad: si falla la membresía, se borra el usuario que esa llamada creó; en el alta de tenants, además, se borra el tenant.
  - La contraseña (de 8 a 72 caracteres) no se registra ni se devuelve al navegador. No se fuerza cambiarla en el primer inicio de sesión; quien la olvide usa "¿Olvidaste tu contraseña?".

### Primer súper administrador

No hay pantalla para crearlo. Crea primero el usuario en Auth (panel de Supabase → Authentication → Users → *Add user*, con contraseña y *Auto Confirm User*; en local, Studio en http://127.0.0.1:54323) y luego, en el editor SQL:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where email = 'tu-correo@ejemplo.com';
```

Para quitarle el rol: `delete from public.platform_admins where user_id = (select id from auth.users where email = 'tu-correo@ejemplo.com');`

### Plantilla del correo de recuperación y URL de redirección

El enlace del correo de recuperación debe llevar a `${APP_URL}/auth/confirm` con `token_hash` y `type` (flujo de servidor; el enlace por defecto de Supabase no sirve porque deja la sesión en el navegador). La aplicación pide la redirección a `${APP_URL}/auth/confirm` y la plantilla arma el enlace con ella:

```html
<!-- Reset password -->
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Elegir una contraseña nueva</a>
```

Si `${APP_URL}/auth/confirm` no está en la lista de URL permitidas, Supabase cambia `RedirectTo` por la *Site URL* y el enlace no funciona.

- **Local (`supabase/config.toml`, ya configurado):**
  - `[auth.email.template.recovery]` usa `supabase/templates/recovery.html` (asunto "Restablece tu contraseña de Access Core");
  - `additional_redirect_urls` incluye `http://localhost:3000/auth/confirm` y `http://127.0.0.1:3000/auth/confirm` (para `APP_URL=http://localhost:3000`);
  - `enable_signup = false`: nadie se registra por su cuenta; el admin API (con el que la aplicación crea las cuentas) sigue funcionando;
  - tras cambiar el archivo: `supabase stop && supabase start`. Los correos locales se ven en Mailpit: http://127.0.0.1:54324.
- **Remoto (panel de Supabase del proyecto):**
  - *Authentication → Emails → Reset password*: asunto "Restablece tu contraseña de Access Core" y el cuerpo de `supabase/templates/recovery.html`;
  - *Authentication → Emails → SMTP Settings*: un SMTP propio. El de Supabase solo envía unos pocos correos por hora y solo a los miembros del equipo del proyecto;
  - *Authentication → URL Configuration*: *Site URL* = `APP_URL`, y en *Redirect URLs* agrega `${APP_URL}/auth/confirm`;
  - *Authentication → Sign In / Providers*: desactiva *Allow new users to sign up*;
  - en Vercel, define `APP_URL` con la URL pública de la aplicación.
