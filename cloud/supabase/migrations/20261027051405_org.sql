-- 0001_org: organización multi-tenant y RLS (N2).
-- Tablas: tenants, platform_admins, tenant_members, installations.
-- Funciones de RLS en el esquema no expuesto `private`.

-- Esquema privado: no está en la lista de esquemas expuestos de la Data API.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  suspended_at timestamptz,
  created_at timestamptz default now()
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'tecnico')),
  primary key (tenant_id, user_id)
);

create table public.installations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  revision bigint not null default 0,
  created_at timestamptz default now()
);

-- Índices para las FK y para las consultas de las políticas
-- (tenant_members(tenant_id) ya lo cubre la llave primaria compuesta).
create index tenant_members_user_id_idx on public.tenant_members (user_id);
create index installations_tenant_id_idx on public.installations (tenant_id);

-- ---------------------------------------------------------------------------
-- Funciones auxiliares de RLS (security definer, sin search_path heredado)
-- ---------------------------------------------------------------------------
create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = (select auth.uid())
  );
$$;

create function private.is_member(t uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.tenants tn on tn.id = m.tenant_id
    where m.tenant_id = t
      and m.user_id = (select auth.uid())
      and tn.suspended_at is null
  );
$$;

create function private.is_tenant_admin(t uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    join public.tenants tn on tn.id = m.tenant_id
    where m.tenant_id = t
      and m.user_id = (select auth.uid())
      and m.role = 'admin'
      and tn.suspended_at is null
  );
$$;

revoke execute on function private.is_platform_admin() from public;
revoke execute on function private.is_member(uuid) from public;
revoke execute on function private.is_tenant_admin(uuid) from public;
grant execute on function private.is_platform_admin() to authenticated, service_role;
grant execute on function private.is_member(uuid) to authenticated, service_role;
grant execute on function private.is_tenant_admin(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grants: el default de Supabase local da a anon/authenticated privilegios
-- (incluido TRUNCATE, que ignora RLS); se retiran y se dan solo los necesarios.
-- ---------------------------------------------------------------------------
revoke all on public.tenants, public.platform_admins, public.tenant_members, public.installations
  from public, anon, authenticated;

grant select, insert, update, delete on public.tenants to authenticated;
grant select, insert, update, delete on public.tenant_members to authenticated;
-- installations: la revisión la asigna el servidor; authenticated solo escribe columnas de usuario.
grant select on public.installations to authenticated;
grant insert (tenant_id, name) on public.installations to authenticated;
grant update (name) on public.installations to authenticated;
-- sin DELETE para authenticated: solo el servidor (service_role) borra instalaciones.
-- platform_admins: sin acceso directo de authenticated; la consulta pasa por
-- private.is_platform_admin() (security definer). Se administra con service_role.

grant all on public.tenants, public.platform_admins, public.tenant_members, public.installations
  to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.platform_admins enable row level security;
alter table public.tenant_members enable row level security;
alter table public.installations enable row level security;

-- platform_admins: RLS activa y sin políticas (nadie salvo service_role/postgres).

-- tenants: lectura para miembros; todo para platform_admin
create policy tenants_select on public.tenants for select to authenticated
  using ((select private.is_member(id)) or (select private.is_platform_admin()));
create policy tenants_insert on public.tenants for insert to authenticated
  with check ((select private.is_platform_admin()));
create policy tenants_update on public.tenants for update to authenticated
  using ((select private.is_platform_admin()))
  with check ((select private.is_platform_admin()));
create policy tenants_delete on public.tenants for delete to authenticated
  using ((select private.is_platform_admin()));

-- tenant_members: lectura para miembros; escritura para admin del tenant o platform_admin
create policy tenant_members_select on public.tenant_members for select to authenticated
  using ((select private.is_member(tenant_id)) or (select private.is_platform_admin()));
create policy tenant_members_insert on public.tenant_members for insert to authenticated
  with check ((select private.is_tenant_admin(tenant_id)) or (select private.is_platform_admin()));
create policy tenant_members_update on public.tenant_members for update to authenticated
  using ((select private.is_tenant_admin(tenant_id)) or (select private.is_platform_admin()))
  with check ((select private.is_tenant_admin(tenant_id)) or (select private.is_platform_admin()));
create policy tenant_members_delete on public.tenant_members for delete to authenticated
  using ((select private.is_tenant_admin(tenant_id)) or (select private.is_platform_admin()));

-- installations: lectura y renombrado para miembros; alta solo para admin del tenant; sin borrado
create policy installations_select on public.installations for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy installations_insert on public.installations for insert to authenticated
  with check ((select private.is_tenant_admin(tenant_id)));
create policy installations_update on public.installations for update to authenticated
  using ((select private.is_member(tenant_id)))
  with check ((select private.is_member(tenant_id)));
