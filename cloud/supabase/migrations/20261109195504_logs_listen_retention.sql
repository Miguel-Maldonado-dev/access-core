-- logs_listen_retention: escucha de RF, "Borrar logs" y retención de 30 días.
--
-- * panel_commands admite kind = 'listen_rf' (el panel captura un código RF y lo informa):
--   - output_index pasa a ser nulo; solo listen_rf va sin salida (check de igualdad);
--   - rf_code: el código capturado, que llega con el resultado;
--   - una sola escucha pendiente por panel.
-- * installations.logs_cleared_at: marca del último "Borrar logs"; los logs con ts anterior
--   o igual a la marca ya no se aceptan (los paneles aún pueden reenviarlos).
-- * log_purges: bitácora de los borrados (quién, cuándo y cuántos logs).
-- * purge_installation_logs: borra los logs de una instalación, fija la marca y deja la
--   bitácora, todo en una transacción. Solo la ejecuta service_role (llave secreta).
-- * Disparador filter_access_log: descarta los logs con motivo 5, anteriores a la marca de
--   borrado de su instalación o de más de 30 días.
-- * Retención: access_logs conserva 30 días (el trabajo access-logs-retention pasa de
--   12 meses mensual a 30 días diario).

-- ---------------------------------------------------------------------------
-- panel_commands: listen_rf
-- ---------------------------------------------------------------------------
alter table public.panel_commands drop constraint panel_commands_kind_check;
alter table public.panel_commands
  add constraint panel_commands_kind_check check (kind in ('test_output', 'remote_open', 'listen_rf'));

alter table public.panel_commands alter column output_index drop not null;
alter table public.panel_commands
  add constraint panel_commands_output_kind_check check ((kind = 'listen_rf') = (output_index is null));

alter table public.panel_commands add column rf_code bigint;
alter table public.panel_commands
  add constraint panel_commands_rf_code_check check (rf_code between 0 and 4294967295);

grant select (rf_code) on public.panel_commands to authenticated;

-- Una sola escucha pendiente por panel (el índice por salida no cubre output_index nulo).
create unique index panel_commands_pending_listen_key
  on public.panel_commands (panel_id) where status = 'pending' and kind = 'listen_rf';

-- ---------------------------------------------------------------------------
-- installations.logs_cleared_at
-- ---------------------------------------------------------------------------
alter table public.installations add column logs_cleared_at timestamptz;
grant select (logs_cleared_at) on public.installations to authenticated;

-- ---------------------------------------------------------------------------
-- log_purges
-- ---------------------------------------------------------------------------
create table public.log_purges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  purged_at timestamptz not null default now(),
  purged_by uuid references auth.users (id) on delete set null,
  purged_by_label text,
  deleted_count int not null
);
create index log_purges_tenant_id_idx on public.log_purges (tenant_id);
create index log_purges_installation_id_idx on public.log_purges (installation_id);
create index log_purges_purged_by_idx on public.log_purges (purged_by);

revoke all on public.log_purges from public, anon, authenticated;
grant select on public.log_purges to authenticated;
grant all on public.log_purges to service_role;

alter table public.log_purges enable row level security;
create policy log_purges_select on public.log_purges for select to authenticated
  using ((select private.is_member(tenant_id)));

-- ---------------------------------------------------------------------------
-- purge_installation_logs
-- ---------------------------------------------------------------------------
create function public.purge_installation_logs(p_installation uuid, p_user uuid, p_label text)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_count int;
begin
  -- El bloqueo de fila hace que un insert de logs concurrente espere y vea la marca nueva.
  select i.tenant_id into v_tenant
  from public.installations i
  where i.id = p_installation
  for update;
  if v_tenant is null then
    raise exception 'instalación no encontrada' using errcode = 'P0002';
  end if;

  delete from public.access_logs l where l.installation_id = p_installation;
  get diagnostics v_count = row_count;

  update public.installations i set logs_cleared_at = now() where i.id = p_installation;

  insert into public.log_purges (tenant_id, installation_id, purged_by, purged_by_label, deleted_count)
  values (v_tenant, p_installation, p_user, p_label, v_count);

  return v_count;
end;
$$;

revoke execute on function public.purge_installation_logs(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.purge_installation_logs(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Filtro de logs entrantes
-- ---------------------------------------------------------------------------
create function private.filter_access_log()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_cleared timestamptz;
begin
  if new.reason = 5 or new.ts < now() - interval '30 days' then
    return null;
  end if;
  select i.logs_cleared_at into v_cleared
  from public.installations i
  where i.id = new.installation_id
  for key share;
  if v_cleared is not null and new.ts <= v_cleared then
    return null;
  end if;
  return new;
end;
$$;

create trigger access_logs_filter before insert on public.access_logs
  for each row execute function private.filter_access_log();

-- ---------------------------------------------------------------------------
-- Retención: índice por fecha y trabajo diario (30 días). cron.schedule con un nombre ya
-- existente lo reemplaza, así que la migración es idempotente.
-- ---------------------------------------------------------------------------
create index access_logs_ts_idx on public.access_logs (ts);

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'access-logs-retention',
  '0 9 * * *',
  $cron$delete from public.access_logs where ts < now() - interval '30 days'$cron$
);
