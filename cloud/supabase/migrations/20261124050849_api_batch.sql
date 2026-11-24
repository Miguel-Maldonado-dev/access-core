-- Lotes de la API pública (`POST .../{holders,cards,controls}/batch`): una sola revisión y
-- un solo aviso a los paneles por lote.
--
-- La lógica de cada elemento vive en la aplicación (varias peticiones a la Data API, cada una
-- en su propia transacción), así que el lote no puede ser una sola transacción. En su lugar,
-- mientras un lote está abierto en una instalación, las escrituras que llegan con el
-- encabezado `x-acc-batch: <token del lote>` (y el rol service_role) reciben la revisión
-- PENDIENTE (installations.revision + 1) sin subir installations.revision: no hay aviso y el
-- pull (since < revision <= R) todavía no las ve. Al cerrar el lote, si hubo alguna escritura
-- confirmada, installations.revision sube una vez (un aviso) y publica todas.
--
-- - Un elemento que falla revierte su transacción, incluida la marca `dirty`: un lote sin
--   cambios confirmados no sube la revisión.
-- - Una escritura ajena al lote mientras está abierto sube la revisión como siempre y con eso
--   publica también lo que el lote llevaba; el lote sigue con la nueva revisión pendiente
--   (en ese caso la instalación sube más de una vez, nunca se pierde una fila).
-- - Si la aplicación muere sin cerrar el lote, caduca (expires_at, 70 s: la función dura como
--   máximo 60 s): la siguiente apertura, la
--   siguiente escritura normal o el trabajo `api-batches-expire` (cada minuto) lo publican.
-- - Varias filas comparten revisión: el pull pagina sin partir un grupo de la misma revisión
--   (src/lib/device/changes.ts).

create table private.installation_batches (
  installation_id uuid primary key references public.installations (id) on delete cascade,
  token uuid not null,
  expires_at timestamptz not null,
  dirty boolean not null default false
);

revoke all on private.installation_batches from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- bump_revision: modo lote
-- ---------------------------------------------------------------------------
create or replace function private.bump_revision(inst uuid)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_headers text := current_setting('request.headers', true);
  v_claims text := current_setting('request.jwt.claims', true);
  v_token text;
  v_rev bigint;
begin
  -- Solo una petición del servidor (service_role) puede escribir dentro de un lote. Supuesto:
  -- PostgREST siempre pone JSON válido (un objeto) en request.headers y request.jwt.claims; solo
  -- se convierte si el texto empieza con '{'. Sin `exception when others` (no abre una
  -- subtransacción en cada escritura replicada) y sin pg_input_is_valid (Postgres 16+).
  -- SQL no garantiza el orden de un `and`: la conversión va en `if` anidados.
  if left(coalesce(v_headers, ''), 1) = '{' and left(coalesce(v_claims, ''), 1) = '{' then
    if v_claims::jsonb ->> 'role' = 'service_role' then
      v_token := v_headers::jsonb ->> 'x-acc-batch';
    end if;
  end if;

  if v_token is not null then
    -- Bloquea la instalación como la rama normal: las escrituras se serializan igual.
    select i.revision into v_rev from public.installations i where i.id = inst for no key update;
    update private.installation_batches b
    set dirty = true
    where b.installation_id = inst and b.token::text = v_token and b.expires_at > now();
    if found then
      return v_rev + 1;
    end if;
  end if;

  update public.installations
  set revision = revision + 1
  where id = inst
  returning revision into v_rev;
  -- Esta revisión publica también lo que llevara un lote abierto: su pendiente pasa a v_rev + 1.
  update private.installation_batches b set dirty = false where b.installation_id = inst and b.dirty;
  return v_rev;
end;
$$;

revoke execute on function private.bump_revision(uuid) from public;
grant execute on function private.bump_revision(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Apertura y cierre del lote (solo service_role)
-- ---------------------------------------------------------------------------
-- Abre un lote. Falso si otro lote vigente ocupa la instalación. Un lote caducado se
-- publica (si tenía cambios) y se reemplaza.
create function public.api_batch_begin(p_installation_id uuid, p_token uuid, p_ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b private.installation_batches;
begin
  perform 1 from public.installations i where i.id = p_installation_id for no key update;
  if not found then
    raise exception 'La instalación no existe.' using errcode = '23503';
  end if;
  select * into v_b from private.installation_batches b where b.installation_id = p_installation_id;
  if found then
    if v_b.expires_at > now() then
      return false;
    end if;
    if v_b.dirty then
      update public.installations set revision = revision + 1 where id = p_installation_id;
    end if;
    delete from private.installation_batches b where b.installation_id = p_installation_id;
  end if;
  insert into private.installation_batches (installation_id, token, expires_at)
  values (p_installation_id, p_token, now() + make_interval(secs => greatest(p_ttl_seconds, 1)));
  return true;
end;
$$;

-- Cierra el lote: si tuvo escrituras confirmadas sube la revisión una vez (un aviso).
-- Devuelve installations.revision al terminar. Con otro token (o ya cerrado) no toca nada.
create function public.api_batch_end(p_installation_id uuid, p_token uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dirty boolean;
  v_rev bigint;
begin
  select i.revision into v_rev from public.installations i where i.id = p_installation_id for no key update;
  delete from private.installation_batches b
  where b.installation_id = p_installation_id and b.token = p_token
  returning b.dirty into v_dirty;
  if coalesce(v_dirty, false) then
    update public.installations set revision = revision + 1 where id = p_installation_id
    returning revision into v_rev;
  end if;
  return v_rev;
end;
$$;

-- Publica los lotes caducados (la aplicación murió sin cerrarlos).
create function private.expire_api_batches()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inst uuid;
begin
  for v_inst in
    select b.installation_id from private.installation_batches b where b.expires_at <= now()
  loop
    perform 1 from public.installations i where i.id = v_inst for no key update;
    update public.installations i set revision = revision + 1
    where i.id = v_inst
      and exists (select 1 from private.installation_batches b
                  where b.installation_id = v_inst and b.dirty and b.expires_at <= now());
    delete from private.installation_batches b where b.installation_id = v_inst and b.expires_at <= now();
  end loop;
end;
$$;

revoke execute on function public.api_batch_begin(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.api_batch_end(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.expire_api_batches() from public, anon, authenticated;
grant execute on function public.api_batch_begin(uuid, uuid, int) to service_role;
grant execute on function public.api_batch_end(uuid, uuid) to service_role;

-- cron.schedule con un nombre ya existente lo reemplaza: la migración es idempotente.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('api-batches-expire', '* * * * *', $cron$select private.expire_api_batches()$cron$);
