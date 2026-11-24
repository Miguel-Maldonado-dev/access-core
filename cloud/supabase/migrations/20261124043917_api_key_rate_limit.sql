-- Límite de peticiones por minuto configurable por llave de API (antes fijo en 120).
-- Solo el servidor (service_role) escribe la columna; el admin del tenant la lee.

alter table public.api_keys
  add column requests_per_minute int not null default 120
    check (requests_per_minute between 1 and 5000);

grant select (requests_per_minute) on public.api_keys to authenticated;

-- Las funciones devuelven la columna nueva, y create_api_key recibe el límite: cambia el tipo
-- de retorno y la firma, así que se reemplazan (drop + create) con sus mismos permisos.
drop function public.create_api_key(uuid, text, text, text, uuid);
drop function public.rotate_api_key(uuid, uuid, text, text, uuid);

create function public.create_api_key(
  p_tenant_id uuid, p_name text, p_prefix text, p_key_hash text, p_created_by uuid,
  p_requests_per_minute int default 120
)
returns table (id uuid, name text, prefix text, created_at timestamptz,
               last_used_at timestamptz, revoked_at timestamptz, requests_per_minute int)
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
    insert into public.api_keys as k (tenant_id, name, prefix, key_hash, created_by, requests_per_minute)
    values (p_tenant_id, p_name, p_prefix, p_key_hash, p_created_by, p_requests_per_minute)
    returning k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, k.requests_per_minute;
end;
$$;

-- La llave nueva conserva el límite de la rotada.
create function public.rotate_api_key(
  p_tenant_id uuid, p_key_id uuid, p_prefix text, p_key_hash text, p_created_by uuid
)
returns table (id uuid, name text, prefix text, created_at timestamptz,
               last_used_at timestamptz, revoked_at timestamptz, requests_per_minute int)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text;
  v_limit int;
begin
  perform pg_advisory_xact_lock(hashtextextended('api_keys:' || p_tenant_id::text, 0));
  update public.api_keys k set revoked_at = now()
  where k.id = p_key_id and k.tenant_id = p_tenant_id and k.revoked_at is null
  returning k.name, k.requests_per_minute into v_name, v_limit;
  if v_name is null then
    return;
  end if;
  return query
    insert into public.api_keys as k (tenant_id, name, prefix, key_hash, created_by, requests_per_minute)
    values (p_tenant_id, v_name, p_prefix, p_key_hash, p_created_by, v_limit)
    returning k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, k.requests_per_minute;
end;
$$;

revoke execute on function public.create_api_key(uuid, text, text, text, uuid, int) from public, anon, authenticated;
revoke execute on function public.rotate_api_key(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_api_key(uuid, text, text, text, uuid, int) to service_role;
grant execute on function public.rotate_api_key(uuid, uuid, text, text, uuid) to service_role;
