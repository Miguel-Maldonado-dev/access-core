-- API pública /api/v1 (etapa 2a): llaves de API, registro de peticiones (límite por minuto)
-- e idempotencia. Solo el servidor escribe; el admin del tenant lee sus llaves sin el hash.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  -- Primeros 12 caracteres del secreto (`acc_` + 8), para reconocer la llave.
  prefix text not null,
  -- sha256 del secreto en hexadecimal; el secreto nunca se guarda.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  -- Usuario que la creó (sin FK: la llave sobrevive a que se borre la cuenta).
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Una fila por petición autenticada, para el límite de 120 por minuto por llave.
create table public.api_requests (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  at timestamptz not null default now()
);

-- Respuestas guardadas por `Idempotency-Key` (24 h).
create table public.api_idempotency (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  idem_key text not null,
  request_hash text not null,
  -- Nulos mientras la petición original sigue en curso.
  status int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (key_id, idem_key)
);

-- ---------------------------------------------------------------------------
-- Índices (key_hash ya tiene el de su UNIQUE; api_idempotency, el de su PK)
-- ---------------------------------------------------------------------------
create index api_keys_tenant_id_idx on public.api_keys (tenant_id);
create index api_requests_key_id_at_idx on public.api_requests (key_id, at);

-- ---------------------------------------------------------------------------
-- Funciones del servidor: crear con límite de 10 vivas y rotar en una transacción
-- ---------------------------------------------------------------------------
-- Crea una llave si el tenant tiene menos de 10 vivas. El candado por tenant evita que
-- dos creaciones simultáneas pasen las dos el conteo. Al rebasar: 'api_key_limit' (P0001).
create function public.create_api_key(
  p_tenant_id uuid, p_name text, p_prefix text, p_key_hash text, p_created_by uuid
)
returns table (id uuid, name text, prefix text, created_at timestamptz,
               last_used_at timestamptz, revoked_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_tenant_id::text, 0));
  if (select count(*) from public.api_keys k
      where k.tenant_id = p_tenant_id and k.revoked_at is null) >= 10 then
    raise exception 'api_key_limit' using errcode = 'P0001';
  end if;
  return query
    insert into public.api_keys as k (tenant_id, name, prefix, key_hash, created_by)
    values (p_tenant_id, p_name, p_prefix, p_key_hash, p_created_by)
    returning k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at;
end;
$$;

-- Revoca la llave viva `p_key_id` del tenant y crea otra con su mismo nombre, en la misma
-- transacción (no cambia el número de vivas). Sin filas si la llave no existe, es de otro
-- tenant o ya estaba revocada.
create function public.rotate_api_key(
  p_tenant_id uuid, p_key_id uuid, p_prefix text, p_key_hash text, p_created_by uuid
)
returns table (id uuid, name text, prefix text, created_at timestamptz,
               last_used_at timestamptz, revoked_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text;
begin
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_tenant_id::text, 0));
  update public.api_keys k set revoked_at = now()
  where k.id = p_key_id and k.tenant_id = p_tenant_id and k.revoked_at is null
  returning k.name into v_name;
  if v_name is null then
    return;
  end if;
  return query
    insert into public.api_keys as k (tenant_id, name, prefix, key_hash, created_by)
    values (p_tenant_id, v_name, p_prefix, p_key_hash, p_created_by)
    returning k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at;
end;
$$;

revoke execute on function public.create_api_key(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.rotate_api_key(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_api_key(uuid, text, text, text, uuid) to service_role;
grant execute on function public.rotate_api_key(uuid, uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Grants: se retiran los defaults de Supabase (incluido TRUNCATE, que ignora RLS).
-- ---------------------------------------------------------------------------
revoke all on public.api_keys, public.api_requests, public.api_idempotency from public, anon, authenticated;

-- api_keys: lectura por columna, sin key_hash; sin escritura para authenticated.
grant select (id, tenant_id, name, prefix, created_at, created_by, last_used_at, revoked_at)
  on public.api_keys to authenticated;
-- api_requests y api_idempotency: sin acceso para authenticated.

grant all on public.api_keys, public.api_requests, public.api_idempotency to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.api_keys enable row level security;
alter table public.api_requests enable row level security;
alter table public.api_idempotency enable row level security;

-- api_keys: solo los admin del tenant (activo) leen sus llaves.
create policy api_keys_select on public.api_keys for select to authenticated
  using ((select private.is_tenant_admin(tenant_id)));

-- api_requests y api_idempotency: RLS activa y sin políticas (solo service_role/postgres).

-- ---------------------------------------------------------------------------
-- Limpieza global: cada hora se borran las respuestas idempotentes de más de 24 h y los
-- registros del límite de peticiones de más de 10 min (la ventana es de 60 s). Cubre las
-- llaves sin tráfico, cuya limpieza por petición nunca corre. cron.schedule con un nombre
-- ya existente lo reemplaza, así que la migración es idempotente.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'api-tables-cleanup',
  '0 * * * *',
  $cron$
    delete from public.api_idempotency where created_at < now() - interval '24 hours';
    delete from public.api_requests where at < now() - interval '10 minutes'
  $cron$
);
