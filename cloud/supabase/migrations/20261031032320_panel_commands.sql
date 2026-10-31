-- panel_commands: órdenes de la nube a los paneles ("Probar" una salida) y marcas de
-- "Actualizar logs".
--
-- * panel_commands: cada orden que la nube publica en acc/<panel_code>/cmd. Hoy solo
--   kind = 'test_output' (activar una salida unos segundos). La crea el servidor después
--   de verificar el rol del usuario; el panel informa el resultado con
--   POST /api/device/v1/command-result y el servidor la marca ok, error o expired.
--   Una orden vive 10 s (expires_at); 'pending' pasada esa hora se informa como 'expired'.
-- * panels.logs_uploaded_at: hora de la última subida de logs del panel (POST /logs, aunque
--   llegue vacía). La página de logs la compara con la hora en que pidió la subida.
-- * installations.logs_requested_at: hora de la última petición de "Actualizar logs"; da
--   el límite de una petición por instalación cada 10 s.
--
-- Quién escribe: solo el servidor (llave secreta). authenticated lee las órdenes de su
-- tenant y las dos columnas nuevas, y no escribe ninguna.

-- ---------------------------------------------------------------------------
-- Tabla
-- ---------------------------------------------------------------------------
create table public.panel_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  panel_id uuid not null references public.panels (id) on delete cascade,
  kind text not null check (kind = 'test_output'),
  output_index int not null check (output_index between 0 and 3),
  -- Correo de quien pidió la orden (viaja al panel para su log) y su usuario de Auth.
  requested_by text not null,
  requested_by_user uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'error', 'expired')),
  detail text,
  finished_at timestamptz,
  -- Una orden terminada lleva la hora de su resultado; una pendiente no.
  constraint panel_commands_finished_status_check check ((status = 'pending') = (finished_at is null))
);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------
-- Órdenes de una salida por estado (¿ya se está probando?). También cubre la FK panel_id.
create index panel_commands_panel_id_output_index_status_idx
  on public.panel_commands (panel_id, output_index, status);
-- Una sola orden pendiente por salida: dos "Probar" simultáneos no publican dos órdenes.
-- El servidor marca 'expired' las pendientes ya caducadas antes de crear otra.
create unique index panel_commands_pending_output_key
  on public.panel_commands (panel_id, output_index) where status = 'pending';
-- Columna de la política y FK hacia tenants, installations y auth.users.
create index panel_commands_tenant_id_idx on public.panel_commands (tenant_id);
create index panel_commands_installation_id_idx on public.panel_commands (installation_id);
create index panel_commands_requested_by_user_idx on public.panel_commands (requested_by_user);

-- El panel de la orden es de su instalación (como outputs y profile_panel_rules).
create trigger panel_commands_panel_installation before insert or update of panel_id, installation_id
  on public.panel_commands
  for each row execute function private.check_panel_installation();

-- ---------------------------------------------------------------------------
-- Columnas nuevas de panels e installations
-- ---------------------------------------------------------------------------
alter table public.panels add column logs_uploaded_at timestamptz;
alter table public.installations add column logs_requested_at timestamptz;

-- panels se lee por columna: se agrega la nueva. installations ya se lee completa y
-- authenticated solo actualiza name, así que logs_requested_at la escribe solo service_role.
grant select (logs_uploaded_at) on public.panels to authenticated;

-- ---------------------------------------------------------------------------
-- Grants: se retiran los defaults de Supabase (incluido TRUNCATE, que ignora RLS).
-- ---------------------------------------------------------------------------
revoke all on public.panel_commands from public, anon, authenticated;
grant select (id, tenant_id, installation_id, panel_id, kind, output_index, requested_by,
              requested_by_user, created_at, expires_at, status, detail, finished_at)
  on public.panel_commands to authenticated;
grant all on public.panel_commands to service_role;

-- ---------------------------------------------------------------------------
-- RLS: los miembros leen las órdenes de su tenant; nadie escribe desde el cliente.
-- ---------------------------------------------------------------------------
alter table public.panel_commands enable row level security;

create policy panel_commands_select on public.panel_commands for select to authenticated
  using ((select private.is_member(tenant_id)));
