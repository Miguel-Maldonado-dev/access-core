-- Borrado definitivo de datos en la nube (diseño 2026-11-23-borrado-definitivo-design.md).
--
-- 1. Vaciado inmediato: private.scrub_deleted_row() (BEFORE INSERT OR UPDATE, solo cuando la
--    fila queda con deleted_at) pone en nulo o en un valor neutro las columnas con datos de
--    cada tabla replicada. Se conservan id, tenant_id, installation_id, las FK, las columnas
--    que no son datos de personas (kind, button, local_permission_id, panel_id, output_index,
--    duration_ms, reader_mask, enabled), revision, updated_at, updated_by, origin y deleted_at.
--    Los índices únicos parciales (where deleted_at is null) ya ignoran las filas borradas.
--    audit_log no guarda datos de las filas (solo tabla, id, operación, autor y fecha).
-- 2. Eliminación definitiva: private.purge_deleted_rows(p_days) borra físicamente las filas
--    con deleted_at de hace más de p_days días (y sus entradas de audit_log), las órdenes
--    terminadas y log_purges de más de p_days días y los paneles revocados sin actividad
--    ni filas que dependan de ellos. Corre a diario con pg_cron (deleted-rows-purge).
-- 3. installations.purged_revision: la revisión más alta eliminada. Un panel cuyo cursor es
--    menor ya no recibirá esos borrados por GET /changes; el feed se lo indica para que
--    reconcilie (ver cloud/src/lib/device/changes.ts).
-- 4. public.purged_rows: lápidas mínimas (tabla, id, instalación y fecha; sin datos) de las
--    filas eliminadas. El push de un panel atrasado que trae una de ellas responde
--    'superseded' y no la revive (private.push_row y private.push_permission envuelven a las
--    anteriores, renombradas *_base). Las lápidas no se depuran: solo guardan ids.
--    Ojo: una migración futura que haga `create or replace` de push_row o push_permission
--    debe reemplazar la *_base, no el envoltorio.
-- 5. Conflictos de sincronización: al borrar una fila se vacían cloud_version y
--    panel_version de sus sync_conflicts (también los que se registren después); la
--    eliminación quita los conflictos revisados de más de 30 días, los de filas eliminadas y
--    las importaciones (panel_imports) de más de 30 días de paneles que ya no esperan revisión.

-- ---------------------------------------------------------------------------
-- 1. Vaciado al borrar
-- ---------------------------------------------------------------------------
-- Security definer: el borrado desde la interfaz (authenticated) también vacía
-- sync_conflicts, que authenticated no puede escribir. Solo la llaman los triggers.
create function private.scrub_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Solo se ejecuta la rama de la tabla del trigger (plpgsql prepara cada sentencia al usarla).
  case tg_table_name
    when 'holders' then
      new.name := '(borrado)';  -- not null y con check de longitud: valor neutro
      new.department := '';
      new.address := '';
      new.notes := '';
      new.pin_ciphertext := null;
      new.pin_lookup := null;
    when 'cards' then
      new.card_code := 0;
      new.description := '';
    when 'controls' then
      new.description := '';
    when 'control_buttons' then
      new.rf_code := 0;
    when 'access_profiles' then
      new.name := '';
    when 'profile_panel_rules' then
      new.output_mask := 0;
      new.card_reader_mask := 0;
      new.pin_reader_mask := 0;
      new.allow_rf := false;
      new.allow_remote := false;
      new.weekday_mask := 0;
      new.start_minute := 0;
      new.end_minute := 0;
    when 'outputs' then
      new.alias := '';
    else
      null;  -- holder_profiles y control_button_panels no tienen datos que vaciar
  end case;
  -- Los conflictos de la fila conservan solo tabla, id, tipo, resolución y fechas.
  update public.sync_conflicts c
     set cloud_version = null, panel_version = null
   where c.row_id = new.id
     and (c.cloud_version is not null or c.panel_version is not null);
  return new;
end;
$$;

revoke execute on function private.scrub_deleted_row() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                           'profile_panel_rules', 'outputs'] loop
    execute format('create trigger %I before insert or update on public.%I
                      for each row when (new.deleted_at is not null)
                      execute function private.scrub_deleted_row()', t || '_scrub_deleted', t);
  end loop;
end;
$$;

-- Filas ya borradas: se vacían con los triggers de revisión y auditoría desactivados (sin
-- revisión nueva ni auditoría; los paneles ya recibieron su borrado). La reescritura de
-- deleted_at dispara solo scrub_deleted_row (la cascada exige old.deleted_at nulo).
do $$
declare
  t text;
begin
  foreach t in array array['holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                           'profile_panel_rules', 'outputs'] loop
    execute format('alter table public.%I disable trigger %I', t, t || '_before_write');
    execute format('alter table public.%I disable trigger %I', t, t || '_audit');
    execute format('update public.%I set deleted_at = deleted_at where deleted_at is not null', t);
    execute format('alter table public.%I enable trigger %I', t, t || '_before_write');
    execute format('alter table public.%I enable trigger %I', t, t || '_audit');
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Eliminación definitiva
-- ---------------------------------------------------------------------------
alter table public.installations add column purged_revision bigint not null default 0;

-- Lápidas de filas eliminadas: solo ids. Sin acceso para anon ni authenticated.
create table public.purged_rows (
  id uuid primary key,
  table_name text not null check (table_name in ('holders', 'cards', 'controls', 'control_buttons',
    'access_profiles', 'holder_profiles', 'profile_panel_rules', 'outputs', 'control_button_panels')),
  installation_id uuid not null references public.installations (id) on delete cascade,
  purged_at timestamptz not null default now()
);
create index purged_rows_installation_id_idx on public.purged_rows (installation_id);
alter table public.purged_rows enable row level security;
revoke all on public.purged_rows from public, anon, authenticated;
grant all on public.purged_rows to service_role;

-- Conflicto nuevo de una fila borrada o eliminada: se guarda sin versiones.
create function private.sync_conflict_scrub()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_table text := case new.table_name
    when 'permissions' then 'access_profiles'
    when 'holder_permissions' then 'holder_profiles'
    else new.table_name end;
  v_gone boolean;
begin
  execute format(
    'select exists (select 1 from public.%I t where t.id = $1 and t.deleted_at is not null)
         or exists (select 1 from public.purged_rows p where p.id = $1)', v_table)
    into v_gone using new.row_id;
  if v_gone then
    new.cloud_version := null;
    new.panel_version := null;
  end if;
  return new;
end;
$$;
revoke execute on function private.sync_conflict_scrub() from public, anon, authenticated;
create trigger sync_conflicts_scrub before insert on public.sync_conflicts
  for each row execute function private.sync_conflict_scrub();

-- Push de un panel: una fila eliminada no se revive.
alter function private.push_row(text, uuid, uuid, text, uuid, timestamptz, text, jsonb)
  rename to push_row_base;
alter function private.push_permission(uuid, uuid, text, uuid, timestamptz, text, jsonb)
  rename to push_permission_base;

create function private.push_row(
  p_table text, p_inst uuid, p_panel_id uuid, p_op text, p_id uuid, p_ts timestamptz,
  p_author text, p_data jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
begin
  if exists (select 1 from public.purged_rows p where p.id = p_id and p.installation_id = p_inst) then
    -- Un borrado ya está aplicado; un alta o cambio pierde frente al borrado definitivo.
    return jsonb_build_object('status', case when p_op = 'delete' then 'applied' else 'superseded' end);
  end if;
  return private.push_row_base(p_table, p_inst, p_panel_id, p_op, p_id, p_ts, p_author, p_data);
end;
$$;

create function private.push_permission(
  p_inst uuid, p_panel_id uuid, p_op text, p_id uuid, p_ts timestamptz, p_author text, p_data jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
begin
  if exists (select 1 from public.purged_rows p where p.id = p_id and p.installation_id = p_inst) then
    return jsonb_build_object('status', case when p_op = 'delete' then 'applied' else 'superseded' end);
  end if;
  return private.push_permission_base(p_inst, p_panel_id, p_op, p_id, p_ts, p_author, p_data);
end;
$$;

revoke execute on function private.push_row(text, uuid, uuid, text, uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;
revoke execute on function private.push_permission(uuid, uuid, text, uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;
grant execute on function private.push_row(text, uuid, uuid, text, uuid, timestamptz, text, jsonb) to service_role;
grant execute on function private.push_permission(uuid, uuid, text, uuid, timestamptz, text, jsonb) to service_role;

-- Índices parciales para encontrar las filas borradas viejas sin recorrer las vivas.
do $$
declare
  t text;
begin
  foreach t in array array['holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                           'holder_profiles', 'profile_panel_rules', 'outputs', 'control_button_panels'] loop
    execute format('create index %I on public.%I (deleted_at) where deleted_at is not null',
                   t || '_deleted_at_idx', t);
  end loop;
end;
$$;
create index audit_log_table_name_row_id_idx on public.audit_log (table_name, row_id);
create index panel_commands_finished_created_at_idx on public.panel_commands (created_at)
  where status <> 'pending';
create index log_purges_purged_at_idx on public.log_purges (purged_at);
create index sync_conflicts_row_id_idx on public.sync_conflicts (row_id);
create index sync_conflicts_reviewed_created_at_idx on public.sync_conflicts (created_at)
  where reviewed_at is not null;

-- Devuelve cuántas filas replicadas eliminó. Las hijas van primero: además de las suyas
-- viejas, se eliminan las de un padre que se elimina (para registrar su revisión y su
-- auditoría, en vez de dejarlas al on delete cascade).
create function private.purge_deleted_rows(p_days int default 30)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_total integer;
begin
  create temp table if not exists tmp_purged (
    table_name text not null,
    id uuid not null,
    installation_id uuid not null,
    revision bigint not null
  ) on commit drop;
  truncate tmp_purged;

  -- Padres que se eliminan.
  create temp table if not exists purged_parents (table_name text, id uuid) on commit drop;
  truncate purged_parents;
  insert into purged_parents
    select 'holders', id from public.holders where deleted_at < v_cutoff
    union all select 'controls', id from public.controls
      where deleted_at < v_cutoff or holder_id in (select h.id from public.holders h where h.deleted_at < v_cutoff)
    union all select 'access_profiles', id from public.access_profiles where deleted_at < v_cutoff;
  insert into purged_parents
    select 'control_buttons', b.id from public.control_buttons b
     where b.deleted_at < v_cutoff
        or b.control_id in (select p.id from purged_parents p where p.table_name = 'controls');

  with d as (
    delete from public.control_button_panels l
     where l.deleted_at < v_cutoff
        or l.button_id in (select p.id from purged_parents p where p.table_name = 'control_buttons')
    returning l.id, l.installation_id, l.revision)
  insert into tmp_purged select 'control_button_panels', id, installation_id, revision from d;

  with d as (
    delete from public.control_buttons b
     where b.id in (select p.id from purged_parents p where p.table_name = 'control_buttons')
    returning b.id, b.installation_id, b.revision)
  insert into tmp_purged select 'control_buttons', id, installation_id, revision from d;

  with d as (
    delete from public.cards c
     where c.deleted_at < v_cutoff
        or c.holder_id in (select p.id from purged_parents p where p.table_name = 'holders')
    returning c.id, c.installation_id, c.revision)
  insert into tmp_purged select 'cards', id, installation_id, revision from d;

  with d as (
    delete from public.holder_profiles hp
     where hp.deleted_at < v_cutoff
        or hp.holder_id in (select p.id from purged_parents p where p.table_name = 'holders')
        or hp.profile_id in (select p.id from purged_parents p where p.table_name = 'access_profiles')
    returning hp.id, hp.installation_id, hp.revision)
  insert into tmp_purged select 'holder_profiles', id, installation_id, revision from d;

  with d as (
    delete from public.profile_panel_rules r
     where r.deleted_at < v_cutoff
        or r.profile_id in (select p.id from purged_parents p where p.table_name = 'access_profiles')
    returning r.id, r.installation_id, r.revision)
  insert into tmp_purged select 'profile_panel_rules', id, installation_id, revision from d;

  with d as (
    delete from public.outputs o where o.deleted_at < v_cutoff
    returning o.id, o.installation_id, o.revision)
  insert into tmp_purged select 'outputs', id, installation_id, revision from d;

  with d as (
    delete from public.controls c
     where c.id in (select p.id from purged_parents p where p.table_name = 'controls')
    returning c.id, c.installation_id, c.revision)
  insert into tmp_purged select 'controls', id, installation_id, revision from d;

  with d as (
    delete from public.access_profiles a
     where a.id in (select p.id from purged_parents p where p.table_name = 'access_profiles')
    returning a.id, a.installation_id, a.revision)
  insert into tmp_purged select 'access_profiles', id, installation_id, revision from d;

  with d as (
    delete from public.holders h
     where h.id in (select p.id from purged_parents p where p.table_name = 'holders')
    returning h.id, h.installation_id, h.revision)
  insert into tmp_purged select 'holders', id, installation_id, revision from d;

  -- Auditoría de las filas eliminadas.
  delete from public.audit_log a
   using tmp_purged p
   where a.table_name = p.table_name and a.row_id = p.id;

  -- Lápidas (solo ids) y conflictos de las filas eliminadas.
  insert into public.purged_rows (id, table_name, installation_id)
  select id, table_name, installation_id from tmp_purged
  on conflict (id) do nothing;
  delete from public.sync_conflicts c using tmp_purged p where c.row_id = p.id;

  -- Marca por instalación: la revisión más alta eliminada (nunca baja).
  update public.installations i
     set purged_revision = m.max_revision
    from (select installation_id, max(revision) as max_revision from tmp_purged group by installation_id) m
   where i.id = m.installation_id
     and i.purged_revision < m.max_revision;

  select count(*) into v_total from tmp_purged;

  -- Conflictos revisados de más de p_days días.
  delete from public.sync_conflicts c where c.reviewed_at is not null and c.created_at < v_cutoff;
  -- Importaciones de más de p_days días de paneles que ya no esperan revisión.
  delete from public.panel_imports i
   using public.panels p
   where p.id = i.panel_id and p.status <> 'awaiting_review' and i.created_at < v_cutoff;

  -- Órdenes terminadas y bitácora de borrado de logs.
  delete from public.panel_commands c where c.status <> 'pending' and c.created_at < v_cutoff;
  delete from public.log_purges l where l.purged_at < v_cutoff;

  -- Paneles revocados sin actividad en p_days días y sin filas replicadas que los nombren
  -- (sus borrados lógicos ya se eliminaron). Arrastran por cascada sus logs, órdenes,
  -- conflictos, cambios procesados e importaciones.
  delete from public.panels p
   where p.status = 'revoked'
     and coalesce(greatest(p.last_seen_at, p.last_sync_at), p.created_at) < v_cutoff
     and not exists (select 1 from public.outputs o where o.panel_id = p.id)
     and not exists (select 1 from public.profile_panel_rules r where r.panel_id = p.id)
     and not exists (select 1 from public.control_button_panels l where l.panel_id = p.id);

  return v_total;
end;
$$;

revoke execute on function private.purge_deleted_rows(int) from public, anon, authenticated;
grant execute on function private.purge_deleted_rows(int) to service_role;

-- Trabajo diario a la misma hora que access-logs-retention. cron.schedule con un nombre ya
-- existente lo reemplaza: la migración es idempotente.
select cron.schedule(
  'deleted-rows-purge',
  '0 9 * * *',
  $cron$select private.purge_deleted_rows(30)$cron$
);
