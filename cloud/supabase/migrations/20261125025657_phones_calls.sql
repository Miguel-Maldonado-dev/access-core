-- phones_calls: datos de la nube para la apertura por llamada (SIM808).
--
-- * public.phones: teléfonos (10 dígitos) de los titulares, replicados como cards (revisión,
--   auditoría, borrado lógico en cascada desde holders, vaciado al borrar, purga con lápida).
--   El número es único entre los teléfonos vivos de la instalación (phones_number_live_key).
-- * public.panel_call_settings: la configuración del módulo de llamadas de cada panel (una
--   fila viva por panel; viaja al panel como `call_settings`, con output_id = output_index).
--   La crean claim_panel, import_rows y esta migración (para los paneles que ya tienen
--   instalación). Los miembros la leen; solo admin la edita. Se borra lógicamente cuando el
--   panel se revoca o queda en otra instalación (cleanup_revoked_panel,
--   cleanup_orphan_panel_rows, claim_panel).
-- * profile_panel_rules.allow_call: viaja como permissions.allow_call. Un panel v7 no lo envía:
--   push_permission conserva el de la nube (false al crear) e import_rows usa false.
-- * apply_panel_change acepta 'phones' (por push_row) y 'call_settings' (private.push_call_settings:
--   se aplica a la fila del panel sin importar el id; LWW por updated_at; un delete nunca se
--   aplica y responde 'superseded').
-- * Se redefinen completas desde su última versión (solo cambia lo de este plan):
--   push_row_base y unique_conflict_version y apply_panel_change (20261030225254_control_button_panels),
--   push_permission_base e import_rows (20261102225408_remote_open), scrub_deleted_row,
--   sync_conflict_scrub y purge_deleted_rows (20261124041857_deleted_rows_purge),
--   delete_installation (20261124045057), cleanup_revoked_panel (20261124040116),
--   cleanup_orphan_panel_rows (20261124060833) y claim_panel (20261030225254). Los check
--   de audit_log, sync_conflicts y purged_rows incluyen las tablas nuevas (device_changes
--   y panel_imports no enumeran tablas). bump_revision (modo lote) es genérico.
--
-- Orden de despliegue: primero la nube (`db push` y enseguida Vercel), después el paquete del
-- panel v8. Un panel v7 con la nube nueva ignora teléfonos y llamada (la nube no se los envía
-- sin `X-Acc-Schema: 8`). No se revierte la nube con paneles v8.

-- ---------------------------------------------------------------------------
-- phones
-- ---------------------------------------------------------------------------
create table public.phones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  holder_id uuid not null,
  number text not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  -- Al borrar se vacía (number = ''): el formato solo se exige a los vivos.
  constraint phones_number_check check (deleted_at is not null or number ~ '^[0-9]{10}$'),
  constraint phones_holder_fkey foreign key (installation_id, holder_id)
    references public.holders (installation_id, id) on delete cascade
);

create unique index phones_number_live_key on public.phones (installation_id, number)
  where deleted_at is null;
create index phones_installation_id_holder_id_idx on public.phones (installation_id, holder_id);
create index phones_installation_id_revision_idx on public.phones (installation_id, revision);
create index phones_tenant_id_idx on public.phones (tenant_id);
create index phones_deleted_at_idx on public.phones (deleted_at) where deleted_at is not null;

create trigger phones_before_write before insert or update on public.phones
  for each row execute function private.replicated_before_write('holder_id', 'holders');
create trigger phones_audit after insert or update on public.phones
  for each row execute function private.replicated_audit();
create trigger phones_scrub_deleted before insert or update on public.phones
  for each row when (new.deleted_at is not null)
  execute function private.scrub_deleted_row();

alter table public.phones enable row level security;
create policy phones_select on public.phones for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy phones_insert on public.phones for insert to authenticated
  with check ((select private.is_member(tenant_id)));
create policy phones_update on public.phones for update to authenticated
  using ((select private.is_member(tenant_id)))
  with check ((select private.is_member(tenant_id)));

revoke all on public.phones from public, anon, authenticated;
grant all on public.phones to service_role;
grant select on public.phones to authenticated;
grant insert (installation_id, number, holder_id, description) on public.phones to authenticated;
grant update (number, holder_id, description, deleted_at) on public.phones to authenticated;

-- Borrar un titular borra lógicamente sus tarjetas, controles, perfiles y teléfonos.
drop trigger holders_soft_delete_cascade on public.holders;
create trigger holders_soft_delete_cascade after update of deleted_at on public.holders
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.replicated_soft_delete_cascade(
    'cards', 'holder_id', 'controls', 'holder_id', 'holder_profiles', 'holder_id', 'phones', 'holder_id');

-- ---------------------------------------------------------------------------
-- panel_call_settings
-- ---------------------------------------------------------------------------
create table public.panel_call_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  -- Cascada: borrar un panel (purga de revocados, delete_installation) se lleva su configuración.
  panel_id uuid not null references public.panels (id) on delete cascade,
  enabled boolean not null default false,
  mode text not null default 'single' check (mode in ('single', 'menu')),
  output_index int not null default 0 check (output_index between 0 and 3),
  menu_mask int not null default 0 check (menu_mask between 0 and 15),
  default_output int check (default_output between 0 and 3),
  call_limit_per_minute int not null default 3 check (call_limit_per_minute between 1 and 20),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  -- La salida predeterminada del menú debe estar entre las salidas del menú.
  constraint panel_call_settings_default_output_in_menu_check
    check (default_output is null or (menu_mask >> default_output) & 1 = 1)
);

create unique index panel_call_settings_panel_live_key on public.panel_call_settings (panel_id)
  where deleted_at is null;
create index panel_call_settings_panel_id_idx on public.panel_call_settings (panel_id);
create index panel_call_settings_installation_id_revision_idx
  on public.panel_call_settings (installation_id, revision);
create index panel_call_settings_tenant_id_idx on public.panel_call_settings (tenant_id);
create index panel_call_settings_deleted_at_idx on public.panel_call_settings (deleted_at)
  where deleted_at is not null;

create trigger panel_call_settings_before_write before insert or update on public.panel_call_settings
  for each row execute function private.replicated_before_write();
create trigger panel_call_settings_panel_installation before insert or update of panel_id, installation_id
  on public.panel_call_settings
  for each row execute function private.check_panel_installation();
create trigger panel_call_settings_audit after insert or update on public.panel_call_settings
  for each row execute function private.replicated_audit();

-- Miembros leen; solo admin edita los valores. Nadie la crea ni la borra desde la interfaz.
alter table public.panel_call_settings enable row level security;
create policy panel_call_settings_select on public.panel_call_settings for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy panel_call_settings_update on public.panel_call_settings for update to authenticated
  using ((select private.is_tenant_admin(tenant_id)))
  with check ((select private.is_tenant_admin(tenant_id)));

revoke all on public.panel_call_settings from public, anon, authenticated;
grant all on public.panel_call_settings to service_role;
grant select on public.panel_call_settings to authenticated;
grant update (enabled, mode, output_index, menu_mask, default_output, call_limit_per_minute)
  on public.panel_call_settings to authenticated;

-- Fila viva del panel en su instalación (si no la tiene). Solo service_role.
create function private.ensure_panel_call_settings(p_panel uuid, p_inst uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_inst is null then
    return;
  end if;
  insert into public.panel_call_settings (installation_id, panel_id, updated_at, updated_by, origin)
  select p_inst, p_panel, now(), 'system:llamadas', 'cloud'
  where not exists (
    select 1 from public.panel_call_settings s
    where s.panel_id = p_panel and s.installation_id = p_inst and s.deleted_at is null);
end;
$$;
revoke execute on function private.ensure_panel_call_settings(uuid, uuid) from public, anon, authenticated;
grant execute on function private.ensure_panel_call_settings(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- profile_panel_rules.allow_call
-- ---------------------------------------------------------------------------
alter table public.profile_panel_rules add column allow_call boolean not null default false;
grant insert (allow_call) on public.profile_panel_rules to authenticated;
grant update (allow_call) on public.profile_panel_rules to authenticated;

-- ---------------------------------------------------------------------------
-- Tablas que se enumeran
-- ---------------------------------------------------------------------------
alter table public.audit_log drop constraint audit_log_table_name_check;
alter table public.audit_log add constraint audit_log_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'control_button_panels',
    'access_profiles', 'holder_profiles', 'profile_panel_rules', 'outputs', 'phones', 'panel_call_settings'));

-- Vocabulario del contrato (tablas locales del panel).
alter table public.sync_conflicts drop constraint sync_conflicts_table_name_check;
alter table public.sync_conflicts add constraint sync_conflicts_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'permissions',
    'holder_permissions', 'outputs', 'phones', 'call_settings'));

alter table public.purged_rows drop constraint purged_rows_table_name_check;
alter table public.purged_rows add constraint purged_rows_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
    'holder_profiles', 'profile_panel_rules', 'outputs', 'control_button_panels', 'phones',
    'panel_call_settings'));

-- ---------------------------------------------------------------------------
-- Vaciado al borrar y conflictos de filas borradas
-- ---------------------------------------------------------------------------
create or replace function private.scrub_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  case tg_table_name
    when 'holders' then
      new.name := '(borrado)';
      new.department := '';
      new.address := '';
      new.notes := '';
      new.pin_ciphertext := null;
      new.pin_lookup := null;
    when 'cards' then
      new.card_code := 0;
      new.description := '';
    when 'phones' then
      new.number := '';
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
      new.allow_call := false;
      new.weekday_mask := 0;
      new.start_minute := 0;
      new.end_minute := 0;
    when 'outputs' then
      new.alias := '';
    else
      null;
  end case;
  update public.sync_conflicts c
     set cloud_version = null, panel_version = null
   where c.row_id = new.id
     and (c.cloud_version is not null or c.panel_version is not null);
  return new;
end;
$$;

create or replace function private.sync_conflict_scrub()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_table text := case new.table_name
    when 'permissions' then 'access_profiles'
    when 'holder_permissions' then 'holder_profiles'
    when 'call_settings' then 'panel_call_settings'
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

-- ---------------------------------------------------------------------------
-- Push de call_settings: la fila del panel, sin importar el id
-- ---------------------------------------------------------------------------
create function private.push_call_settings(
  p_inst uuid, p_panel_id uuid, p_op text, p_ts timestamptz, p_author text, p_data jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_row public.panel_call_settings;
begin
  perform private.ensure_panel_call_settings(p_panel_id, p_inst);
  select * into v_row from public.panel_call_settings s
   where s.panel_id = p_panel_id and s.installation_id = p_inst and s.deleted_at is null;
  -- La configuración no se borra: el panel recibe la de la nube.
  if p_op = 'delete' then
    return jsonb_build_object('status', 'superseded');
  end if;
  -- En empate gana la nube.
  if v_row.updated_at >= p_ts then
    return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
      'kind', 'lww', 'cloud_version', to_jsonb(v_row),
      'resolution', 'Gana la nube: su versión es más reciente.'));
  end if;
  update public.panel_call_settings s
     set enabled = (p_data ->> 'enabled')::boolean,
         mode = p_data ->> 'mode',
         output_index = (p_data ->> 'output_id')::int,
         menu_mask = (p_data ->> 'menu_mask')::int,
         default_output = (p_data ->> 'default_output')::int,
         call_limit_per_minute = coalesce((p_data ->> 'call_limit_per_minute')::int, s.call_limit_per_minute),
         updated_at = p_ts, updated_by = p_author, origin = p_author
   where s.id = v_row.id;
  return jsonb_build_object('status', 'applied');
end;
$$;
revoke execute on function private.push_call_settings(uuid, uuid, text, timestamptz, text, jsonb)
  from public, anon, authenticated;
grant execute on function private.push_call_settings(uuid, uuid, text, timestamptz, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Funciones de sincronización redefinidas (create or replace conserva sus grants)
-- ---------------------------------------------------------------------------
create or replace function private.push_row_base(
  p_table text,
  p_inst uuid,
  p_panel_id uuid,
  p_op text,
  p_id uuid,
  p_ts timestamptz,
  p_author text,
  p_data jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- Toda lectura y escritura va acotada a la instalación (y en outputs, al panel).
  v_scope text := 't.id = $1 and t.installation_id = $2'
    || case when p_table = 'outputs' then ' and t.panel_id = $3' else '' end;
  v_cols text[];
  v_ins_cols text[];
  v_list text;
  v_rlist text;
  v_row jsonb;
  v_data jsonb := p_data;
  v_profile_id uuid;
  v_exists boolean;
begin
  v_cols := case p_table
    when 'holders' then array['kind', 'name', 'department', 'address', 'notes', 'pin_ciphertext', 'pin_lookup']
    when 'cards' then array['card_code', 'holder_id', 'description']
    when 'controls' then array['holder_id', 'description']
    when 'control_buttons' then array['control_id', 'button', 'rf_code']
    when 'holder_profiles' then array['holder_id', 'profile_id']
    when 'phones' then array['holder_id', 'number', 'description']
    when 'outputs' then array['output_index', 'alias', 'duration_ms', 'reader_mask', 'enabled']
  end;
  if v_cols is null then
    raise exception 'Tabla sin sincronización: %', p_table using errcode = '22023';
  end if;

  execute format('select to_jsonb(t) from public.%I t where %s', p_table, v_scope)
    into v_row using p_id, p_inst, p_panel_id;
  if v_row is null then
    -- El id existe fuera del alcance del panel (otra instalación u otro panel).
    execute format('select exists (select 1 from public.%I t where t.id = $1)', p_table)
      into v_exists using p_id;
    if v_exists then
      return jsonb_build_object('status', 'rejected', 'reason', 'no encontrado');
    end if;
  end if;

  if p_op = 'delete' then
    if v_row is null or v_row ->> 'deleted_at' is not null then
      return jsonb_build_object('status', 'applied');
    end if;
    if (v_row ->> 'updated_at')::timestamptz >= p_ts then
      return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
        'kind', 'lww', 'cloud_version', private.sync_version(v_row),
        'resolution', 'Gana la nube: su versión es más reciente.'));
    end if;
    execute format(
      'update public.%I t set deleted_at = now(), updated_at = $4, updated_by = $5, origin = $5 where %s',
      p_table, v_scope)
      using p_id, p_inst, p_panel_id, p_ts, p_author;
    return jsonb_build_object('status', 'applied');
  end if;

  if v_row is not null then
    -- El borrado de la nube es definitivo: no se revive.
    if v_row ->> 'deleted_at' is not null then
      return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
        'kind', 'lww', 'cloud_version', private.sync_version(v_row),
        'resolution', 'Gana la nube: el registro está borrado.'));
    end if;
    -- En empate gana la nube.
    if (v_row ->> 'updated_at')::timestamptz >= p_ts then
      return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
        'kind', 'lww', 'cloud_version', private.sync_version(v_row),
        'resolution', 'Gana la nube: su versión es más reciente.'));
    end if;
  end if;

  if p_table = 'holder_profiles' then
    select ap.id into v_profile_id
    from public.access_profiles ap
    where ap.installation_id = p_inst
      and ap.local_permission_id = (p_data ->> 'permission_id')::int
      and ap.deleted_at is null;
    if v_profile_id is null then
      return jsonb_build_object('status', 'rejected', 'reason', 'relacionado no existe');
    end if;
    v_data := jsonb_build_object('holder_id', p_data -> 'holder_id', 'profile_id', v_profile_id);
  end if;

  if v_row is null then
    v_ins_cols := v_cols;
    if p_table = 'outputs' then
      v_ins_cols := array_append(v_ins_cols, 'panel_id');
      v_data := v_data || jsonb_build_object('panel_id', p_panel_id);
    end if;
    select string_agg(format('%I', c), ', ' order by n), string_agg(format('r.%I', c), ', ' order by n)
      into v_list, v_rlist
    from unnest(v_ins_cols) with ordinality as u (c, n);
    execute format(
      'insert into public.%1$I (id, installation_id, %2$s, updated_at, updated_by, origin)
       select $1, $2, %3$s, $4, $5, $5 from jsonb_populate_record(null::public.%1$I, $6) r',
      p_table, v_list, v_rlist)
      using p_id, p_inst, p_panel_id, p_ts, p_author, v_data;
  else
    select string_agg(format('%I', c), ', ' order by n), string_agg(format('r.%I', c), ', ' order by n)
      into v_list, v_rlist
    from unnest(v_cols) with ordinality as u (c, n);
    execute format(
      'update public.%1$I t set (%2$s, updated_at, updated_by, origin) =
         (select %3$s, $4, $5, $5 from jsonb_populate_record(null::public.%1$I, $6) r)
       where %4$s',
      p_table, v_list, v_rlist, v_scope)
      using p_id, p_inst, p_panel_id, p_ts, p_author, v_data;
  end if;
  return jsonb_build_object('status', 'applied');
end;
$$;

create or replace function private.push_permission_base(
  p_inst uuid,
  p_panel_id uuid,
  p_op text,
  p_id uuid,
  p_ts timestamptz,
  p_author text,
  p_data jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_profile public.access_profiles;
  v_rule public.profile_panel_rules;
  v_other public.access_profiles;
  v_cloud jsonb;
  v_lww jsonb;
begin
  select * into v_profile
  from public.access_profiles ap
  where ap.id = p_id and ap.installation_id = p_inst;
  if v_profile.id is null and exists (select 1 from public.access_profiles ap where ap.id = p_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'no encontrado');
  end if;

  if v_profile.id is not null then
    select * into v_rule
    from public.profile_panel_rules r
    where r.profile_id = p_id and r.panel_id = p_panel_id and r.installation_id = p_inst
    order by (r.deleted_at is null) desc, r.updated_at desc
    limit 1;
    v_cloud := jsonb_build_object(
      'profile', to_jsonb(v_profile),
      'rule', case when v_rule.id is null then null else to_jsonb(v_rule) end);
    v_lww := jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
      'kind', 'lww', 'cloud_version', v_cloud,
      'resolution', 'Gana la nube: su versión es más reciente.'));
  end if;

  if p_op = 'delete' then
    if v_profile.id is null or v_profile.deleted_at is not null then
      return jsonb_build_object('status', 'applied');
    end if;
    if greatest(v_profile.updated_at, v_rule.updated_at) >= p_ts then
      return v_lww;
    end if;
    -- La cascada de N3 borra sus holder_profiles y sus reglas en todos los paneles.
    update public.access_profiles ap
       set deleted_at = now(), updated_at = p_ts, updated_by = p_author, origin = p_author
     where ap.id = p_id and ap.installation_id = p_inst;
    return jsonb_build_object('status', 'applied');
  end if;

  if v_profile.id is null then
    -- Perfil nuevo: su local_permission_id es el permission_id del panel.
    select * into v_other
    from public.access_profiles ap
    where ap.installation_id = p_inst
      and ap.local_permission_id = (p_data ->> 'permission_id')::int
      and ap.deleted_at is null;
    if v_other.id is not null then
      return jsonb_build_object('status', 'rejected', 'reason', 'duplicado', 'conflict', jsonb_build_object(
        'kind', 'unique', 'cloud_version', to_jsonb(v_other), 'resolution', 'Rechazado: duplicado.'));
    end if;
    insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_at, updated_by, origin)
    values (p_id, p_inst, p_data ->> 'name', (p_data ->> 'permission_id')::int, p_ts, p_author, p_author);
  else
    if v_profile.deleted_at is not null then
      return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
        'kind', 'lww', 'cloud_version', v_cloud,
        'resolution', 'Gana la nube: el registro está borrado.'));
    end if;
    if greatest(v_profile.updated_at, v_rule.updated_at) >= p_ts then
      return v_lww;
    end if;
    if v_profile.local_permission_id <> (p_data ->> 'permission_id')::int then
      return jsonb_build_object('status', 'rejected', 'reason', 'permission_id distinto');
    end if;
    -- El perfil es de toda la instalación: solo se escribe si cambió el nombre.
    if v_profile.name is distinct from p_data ->> 'name' then
      update public.access_profiles ap
         set name = p_data ->> 'name', updated_at = p_ts, updated_by = p_author, origin = p_author
       where ap.id = p_id and ap.installation_id = p_inst;
    end if;
  end if;

  if v_rule.id is not null and v_rule.deleted_at is null then
    update public.profile_panel_rules r
       set output_mask = (p_data ->> 'output_mask')::int,
           card_reader_mask = (p_data ->> 'card_reader_mask')::int,
           pin_reader_mask = (p_data ->> 'pin_reader_mask')::int,
           allow_rf = (p_data ->> 'allow_rf')::boolean,
           -- Un panel v6 no envía allow_remote: se conserva el de la nube.
           allow_remote = coalesce((p_data ->> 'allow_remote')::boolean, r.allow_remote),
           -- Un panel v7 no envía allow_call: se conserva el de la nube.
           allow_call = coalesce((p_data ->> 'allow_call')::boolean, r.allow_call),
           weekday_mask = (p_data ->> 'weekday_mask')::int,
           start_minute = (p_data ->> 'start_minute')::int,
           end_minute = (p_data ->> 'end_minute')::int,
           updated_at = p_ts, updated_by = p_author, origin = p_author
     where r.id = v_rule.id and r.installation_id = p_inst and r.panel_id = p_panel_id;
  else
    insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                            pin_reader_mask, allow_rf, allow_remote, allow_call, weekday_mask,
                                            start_minute, end_minute, updated_at, updated_by, origin)
    values (p_inst, p_id, p_panel_id, (p_data ->> 'output_mask')::int, (p_data ->> 'card_reader_mask')::int,
            (p_data ->> 'pin_reader_mask')::int, (p_data ->> 'allow_rf')::boolean,
            coalesce((p_data ->> 'allow_remote')::boolean, false),
            coalesce((p_data ->> 'allow_call')::boolean, false),
            (p_data ->> 'weekday_mask')::int, (p_data ->> 'start_minute')::int, (p_data ->> 'end_minute')::int,
            p_ts, p_author, p_author);
  end if;
  return jsonb_build_object('status', 'applied');
end;
$$;

create or replace function private.import_rows(p_inst uuid, p_panel_id uuid, p_author text, p_plan jsonb)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_holders jsonb := private.import_id_map('holders', p_plan -> 'holders');
  v_cards jsonb := private.import_id_map('cards', p_plan -> 'cards');
  v_controls jsonb := private.import_id_map('controls', p_plan -> 'controls');
  v_buttons jsonb := private.import_id_map('control_buttons', p_plan -> 'control_buttons');
  v_profiles jsonb := private.import_id_map('access_profiles', p_plan -> 'access_profiles');
  v_holder_profiles jsonb := private.import_id_map('holder_profiles', p_plan -> 'holder_profiles');
  v_outputs jsonb := private.import_id_map('outputs', p_plan -> 'outputs');
  v_phones jsonb := private.import_id_map('phones', p_plan -> 'phones');
  -- call_settings llega como objeto (o como lista de una fila).
  v_settings jsonb := case jsonb_typeof(p_plan -> 'call_settings')
    when 'object' then p_plan -> 'call_settings'
    when 'array' then p_plan -> 'call_settings' -> 0
  end;
begin
  insert into public.holders (id, installation_id, kind, name, department, address, notes, pin_ciphertext,
                              pin_lookup, updated_at, updated_by, origin)
  select private.import_id(v_holders, r.id), p_inst, r.kind, r.name, r.department, r.address, r.notes,
         r.pin_ciphertext, r.pin_lookup, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'holders', '[]'::jsonb)) as r (
    id uuid, kind text, name text, department text, address text, notes text, pin_ciphertext text, pin_lookup text);

  update public.holders h
     set pin_ciphertext = r.pin_ciphertext, pin_lookup = r.pin_lookup,
         updated_at = v_now, updated_by = p_author, origin = p_author
    from jsonb_to_recordset(coalesce(p_plan -> 'holder_pins', '[]'::jsonb)) as r (
      holder_id uuid, pin_ciphertext text, pin_lookup text)
   where h.id = r.holder_id
     and h.installation_id = p_inst
     and h.deleted_at is null
     and h.pin_ciphertext is null;

  insert into public.cards (id, installation_id, card_code, holder_id, description, updated_at, updated_by, origin)
  select private.import_id(v_cards, r.id), p_inst, r.card_code, private.import_id(v_holders, r.holder_id),
         r.description, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'cards', '[]'::jsonb)) as r (
    id uuid, card_code bigint, holder_id uuid, description text);

  insert into public.controls (id, installation_id, holder_id, description, updated_at, updated_by, origin)
  select private.import_id(v_controls, r.id), p_inst, private.import_id(v_holders, r.holder_id), r.description,
         v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'controls', '[]'::jsonb)) as r (id uuid, holder_id uuid, description text);

  insert into public.control_buttons (id, installation_id, control_id, button, rf_code,
                                      updated_at, updated_by, origin)
  select private.import_id(v_buttons, r.id), p_inst, private.import_id(v_controls, r.control_id), r.button,
         r.rf_code, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'control_buttons', '[]'::jsonb)) as r (
    id uuid, control_id uuid, button int, rf_code bigint);

  -- Vínculos con este panel: los vivos solo cambian de salida (si cambia); los demás se
  -- dan de alta.
  update public.control_button_panels l
     set output_index = r.output_index, updated_at = v_now, updated_by = p_author, origin = p_author
    from jsonb_to_recordset(coalesce(p_plan -> 'control_button_links', '[]'::jsonb)) as r (
      button_id uuid, output_index int)
   where l.button_id = private.import_id(v_buttons, r.button_id)
     and l.panel_id = p_panel_id
     and l.installation_id = p_inst
     and l.deleted_at is null
     and l.output_index is distinct from r.output_index;

  insert into public.control_button_panels (installation_id, button_id, panel_id, output_index,
                                            updated_at, updated_by, origin)
  select p_inst, private.import_id(v_buttons, r.button_id), p_panel_id, r.output_index, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'control_button_links', '[]'::jsonb)) as r (
    button_id uuid, output_index int)
  where not exists (
    select 1 from public.control_button_panels l
    where l.button_id = private.import_id(v_buttons, r.button_id)
      and l.panel_id = p_panel_id
      and l.deleted_at is null);

  insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_at, updated_by, origin)
  select private.import_id(v_profiles, r.id), p_inst, r.name, r.local_permission_id, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, name text, local_permission_id int);

  insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                          pin_reader_mask, allow_rf, allow_remote, allow_call, weekday_mask,
                                          start_minute, end_minute, updated_at, updated_by, origin)
  select p_inst, private.import_id(v_profiles, r.id), p_panel_id, r.output_mask, r.card_reader_mask,
         r.pin_reader_mask, r.allow_rf, coalesce(r.allow_remote, false), coalesce(r.allow_call, false), r.weekday_mask, r.start_minute,
         r.end_minute, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, output_mask int, card_reader_mask int, pin_reader_mask int, allow_rf boolean, allow_remote boolean, allow_call boolean,
    weekday_mask int, start_minute int, end_minute int);

  insert into public.holder_profiles (id, installation_id, holder_id, profile_id, updated_at, updated_by, origin)
  select private.import_id(v_holder_profiles, r.id), p_inst, private.import_id(v_holders, r.holder_id),
         private.import_id(v_profiles, r.profile_id), v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'holder_profiles', '[]'::jsonb)) as r (
    id uuid, holder_id uuid, profile_id uuid);

  -- Salidas: las vivas del panel en esta instalación se actualizan (solo si cambian);
  -- los índices que no tiene se dan de alta.
  update public.outputs o
     set alias = r.alias, duration_ms = r.duration_ms, reader_mask = r.reader_mask, enabled = r.enabled,
         updated_at = v_now, updated_by = p_author, origin = p_author
    from jsonb_to_recordset(coalesce(p_plan -> 'outputs', '[]'::jsonb)) as r (
      output_index int, alias text, duration_ms int, reader_mask int, enabled boolean)
   where o.panel_id = p_panel_id
     and o.installation_id = p_inst
     and o.deleted_at is null
     and o.output_index = r.output_index
     and (o.alias, o.duration_ms, o.reader_mask, o.enabled)
         is distinct from (r.alias, r.duration_ms, r.reader_mask, r.enabled);

  insert into public.outputs (id, installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled,
                              updated_at, updated_by, origin)
  select private.import_id(v_outputs, r.id), p_inst, p_panel_id, r.output_index, r.alias, r.duration_ms,
         r.reader_mask, r.enabled, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'outputs', '[]'::jsonb)) as r (
    id uuid, output_index int, alias text, duration_ms int, reader_mask int, enabled boolean)
  where not exists (
    select 1 from public.outputs o
    where o.panel_id = p_panel_id
      and o.installation_id = p_inst
      and o.deleted_at is null
      and o.output_index = r.output_index);

  -- Teléfonos del panel (vacío si su módulo de llamadas está apagado).
  insert into public.phones (id, installation_id, holder_id, number, description, updated_at, updated_by, origin)
  select private.import_id(v_phones, r.id), p_inst, private.import_id(v_holders, r.holder_id), r.number,
         coalesce(r.description, ''), v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'phones', '[]'::jsonb)) as r (
    id uuid, holder_id uuid, number text, description text);

  -- Configuración de llamadas: el panel siempre tiene su fila viva; si el plan la trae,
  -- toma sus valores (solo si cambian).
  perform private.ensure_panel_call_settings(p_panel_id, p_inst);
  if v_settings is not null then
    update public.panel_call_settings s
       set enabled = (v_settings ->> 'enabled')::boolean,
           mode = v_settings ->> 'mode',
           output_index = (v_settings ->> 'output_id')::int,
           menu_mask = (v_settings ->> 'menu_mask')::int,
           default_output = (v_settings ->> 'default_output')::int,
           call_limit_per_minute = coalesce((v_settings ->> 'call_limit_per_minute')::int, s.call_limit_per_minute),
           updated_at = v_now, updated_by = p_author, origin = p_author
     where s.panel_id = p_panel_id
       and s.installation_id = p_inst
       and s.deleted_at is null
       and (s.enabled, s.mode, s.output_index, s.menu_mask, s.default_output, s.call_limit_per_minute)
           is distinct from ((v_settings ->> 'enabled')::boolean, v_settings ->> 'mode',
                             (v_settings ->> 'output_id')::int, (v_settings ->> 'menu_mask')::int,
                             (v_settings ->> 'default_output')::int,
                             coalesce((v_settings ->> 'call_limit_per_minute')::int, s.call_limit_per_minute));
  end if;
end;
$$;

create or replace function private.unique_conflict_version(p_inst uuid, p_panel_id uuid, p_constraint text, p_data jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case p_constraint
    when 'cards_card_code_live_key' then
      (select to_jsonb(c) from public.cards c
        where c.installation_id = p_inst and c.card_code = (p_data ->> 'card_code')::bigint
          and c.deleted_at is null)
    when 'control_buttons_rf_code_live_key' then
      (select to_jsonb(b) from public.control_buttons b
        where b.installation_id = p_inst and b.rf_code = (p_data ->> 'rf_code')::bigint
          and b.deleted_at is null)
    when 'control_button_panels_panel_button_live_key' then
      private.button_occupant_version(p_inst, p_panel_id, (p_data ->> 'control_id')::uuid,
                                      (p_data ->> 'button')::int)
    when 'phones_number_live_key' then
      (select to_jsonb(f) from public.phones f
        where f.installation_id = p_inst and f.number = p_data ->> 'number'
          and f.deleted_at is null)
    when 'holders_pin_lookup_live_key' then
      (select private.sync_version(to_jsonb(h)) from public.holders h
        where h.installation_id = p_inst and h.pin_lookup = p_data ->> 'pin_lookup'
          and h.deleted_at is null)
  end;
$$;

create or replace function public.apply_panel_change(
  p_panel_id uuid,
  p_change_id text,
  p_table text,
  p_op text,
  p_row_id uuid,
  p_updated_at timestamptz,
  p_clock_skewed boolean,
  p_data jsonb,
  p_panel_version jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_inst uuid;
  v_author text;
  v_tenant uuid;
  v_rev_before bigint;
  v_rev_after bigint;
  v_ts timestamptz;
  v_out jsonb;
  v_result jsonb;
  v_constraint text;
begin
  if p_table not in ('holders', 'cards', 'controls', 'control_buttons', 'permissions',
                     'holder_permissions', 'outputs', 'phones', 'call_settings')
     or p_op not in ('upsert', 'delete')
     or (p_op = 'upsert' and p_data is null)
     or p_updated_at is null then
    raise exception 'Cambio inválido.' using errcode = '22023';
  end if;

  select p.installation_id, 'panel:' || p.panel_code into v_inst, v_author
  from public.panels p
  where p.id = p_panel_id;
  if v_inst is null then
    raise exception 'El panel no existe o no tiene instalación.' using errcode = '22023';
  end if;

  select i.tenant_id, i.revision into v_tenant, v_rev_before
  from public.installations i
  where i.id = v_inst
  for no key update;

  select dc.result into v_result
  from public.device_changes dc
  where dc.panel_id = p_panel_id and dc.change_id = p_change_id;
  if v_result is not null then
    return v_result;
  end if;

  v_ts := case when p_clock_skewed then now() else p_updated_at end;
  if p_clock_skewed then
    insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind,
                                       cloud_version, panel_version, resolution)
    values (v_tenant, v_inst, p_panel_id, p_table, p_row_id, 'skew',
            jsonb_build_object('updated_at', v_ts), p_panel_version,
            'Hora del panel adelantada: se usó la hora del servidor.');
  end if;

  begin
    if p_table = 'permissions' then
      v_out := private.push_permission(v_inst, p_panel_id, p_op, p_row_id, v_ts, v_author, p_data);
    elsif p_table = 'call_settings' then
      v_out := private.push_call_settings(v_inst, p_panel_id, p_op, v_ts, v_author, p_data);
    elsif p_table = 'control_buttons' then
      v_out := private.push_control_button(v_inst, p_panel_id, p_op, p_row_id, v_ts, v_author, p_data);
    elsif p_table = 'controls' and p_op = 'delete' then
      v_out := private.push_control_delete(v_inst, p_panel_id, p_row_id, v_ts, v_author);
    else
      v_out := private.push_row(
        case when p_table = 'holder_permissions' then 'holder_profiles' else p_table end,
        v_inst, p_panel_id, p_op, p_row_id, v_ts, v_author, p_data);
    end if;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint like '%\_pkey' then
        -- Mismo id en otra instalación, dado de alta mientras tanto.
        v_out := jsonb_build_object('status', 'rejected', 'reason', 'no encontrado');
      else
        v_out := jsonb_build_object('status', 'rejected', 'reason', 'duplicado', 'conflict', jsonb_build_object(
          'kind', 'unique',
          'cloud_version', private.unique_conflict_version(v_inst, p_panel_id, v_constraint, p_data),
          'resolution', 'Rechazado: duplicado.'));
      end if;
    when foreign_key_violation then
      v_out := jsonb_build_object('status', 'rejected', 'reason', 'relacionado no existe');
  end;

  if v_out ? 'conflict' then
    insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind,
                                       cloud_version, panel_version, resolution)
    values (v_tenant, v_inst, p_panel_id, p_table, p_row_id, v_out -> 'conflict' ->> 'kind',
            nullif(v_out -> 'conflict' -> 'cloud_version', 'null'::jsonb), p_panel_version,
            v_out -> 'conflict' ->> 'resolution');
  end if;

  select i.revision into v_rev_after from public.installations i where i.id = v_inst;
  v_result := jsonb_strip_nulls(jsonb_build_object(
    'status', v_out ->> 'status',
    'revision', case when v_out ->> 'status' = 'applied' and v_rev_after > v_rev_before then v_rev_after end,
    'reason', v_out ->> 'reason'));
  insert into public.device_changes (panel_id, change_id, result) values (p_panel_id, p_change_id, v_result);
  return v_result;
end;
$$;

-- claim_panel (20261030225254): además crea la configuración de llamadas del panel.
create or replace function public.claim_panel(
  p_panel_id uuid,
  p_claim_code_hash text,
  p_installation_id uuid
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_panel jsonb;
begin
  update public.panels p
     set status = 'claimed', installation_id = p_installation_id, claim_code_hash = null
   where p.id = p_panel_id
     and p.status = 'pending'
     and p.claim_code_hash = p_claim_code_hash
  returning jsonb_build_object('id', p.id, 'panel_code', p.panel_code, 'status', p.status,
                               'installation_id', p.installation_id)
  into v_panel;
  if v_panel is null then
    return null;
  end if;

  update public.outputs o
     set deleted_at = now(), updated_at = now(), updated_by = 'system:reclamo', origin = 'cloud'
   where o.panel_id = p_panel_id
     and o.installation_id <> p_installation_id
     and o.deleted_at is null;
  update public.profile_panel_rules r
     set deleted_at = now(), updated_at = now(), updated_by = 'system:reclamo', origin = 'cloud'
   where r.panel_id = p_panel_id
     and r.installation_id <> p_installation_id
     and r.deleted_at is null;
  update public.control_button_panels l
     set deleted_at = now(), updated_at = now(), updated_by = 'system:reclamo', origin = 'cloud'
   where l.panel_id = p_panel_id
     and l.installation_id <> p_installation_id
     and l.deleted_at is null;

  update public.panel_call_settings s
     set deleted_at = now(), updated_at = now(), updated_by = 'system:reclamo', origin = 'cloud'
   where s.panel_id = p_panel_id
     and s.installation_id <> p_installation_id
     and s.deleted_at is null;
  -- Cada panel con instalación tiene su configuración de llamadas (apagada al crearla).
  perform private.ensure_panel_call_settings(p_panel_id, p_installation_id);

  return v_panel;
end;
$$;


-- Revocación y huérfanos: también la configuración de llamadas del panel.
create or replace function private.cleanup_revoked_panel(p_panel uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  update public.outputs o
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
   where o.panel_id = p_panel
     and o.deleted_at is null;
  update public.profile_panel_rules r
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
   where r.panel_id = p_panel
     and r.deleted_at is null;
  update public.control_button_panels l
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
   where l.panel_id = p_panel
     and l.deleted_at is null;
  update public.panel_call_settings s
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
   where s.panel_id = p_panel
     and s.deleted_at is null;
  update public.panel_commands c
     set status = 'expired', finished_at = now()
   where c.panel_id = p_panel
     and c.status = 'pending';
end;
$$;


create or replace function private.cleanup_orphan_panel_rows(p_panel uuid default null)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  update public.outputs o
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
    from public.panels p
   where p.id = o.panel_id
     and (p_panel is null or p.id = p_panel)
     and o.deleted_at is null
     and p.installation_id is distinct from o.installation_id;
  update public.profile_panel_rules r
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
    from public.panels p
   where p.id = r.panel_id
     and (p_panel is null or p.id = p_panel)
     and r.deleted_at is null
     and p.installation_id is distinct from r.installation_id;
  update public.control_button_panels l
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
    from public.panels p
   where p.id = l.panel_id
     and (p_panel is null or p.id = p_panel)
     and l.deleted_at is null
     and p.installation_id is distinct from l.installation_id;
  update public.panel_call_settings s
     set deleted_at = now(), updated_at = now(), updated_by = 'system:revocacion', origin = 'cloud'
    from public.panels p
   where p.id = s.panel_id
     and (p_panel is null or p.id = p_panel)
     and s.deleted_at is null
     and p.installation_id is distinct from s.installation_id;
  update public.panel_commands c
     set status = 'expired', finished_at = now()
    from public.panels p
   where p.id = c.panel_id
     and (p_panel is null or p.id = p_panel)
     and c.status = 'pending'
     and p.installation_id is distinct from c.installation_id;
end;
$$;


-- Purga: teléfonos y configuraciones borradas; un panel revocado con configuración no se elimina.
create or replace function private.purge_deleted_rows(p_days int default 30)
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
    delete from public.phones f
     where f.deleted_at < v_cutoff
        or f.holder_id in (select p.id from purged_parents p where p.table_name = 'holders')
    returning f.id, f.installation_id, f.revision)
  insert into tmp_purged select 'phones', id, installation_id, revision from d;

  with d as (
    delete from public.panel_call_settings s where s.deleted_at < v_cutoff
    returning s.id, s.installation_id, s.revision)
  insert into tmp_purged select 'panel_call_settings', id, installation_id, revision from d;

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
     and not exists (select 1 from public.control_button_panels l where l.panel_id = p.id)
     and not exists (select 1 from public.panel_call_settings s where s.panel_id = p.id);

  return v_total;
end;
$$;


-- delete_installation: también teléfonos y configuraciones de llamadas.
create or replace function public.delete_installation(p_installation uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  -- Bloquea la fila: un alta concurrente que la referencie espera y falla por la FK.
  perform 1 from public.installations i where i.id = p_installation for update;
  if not found then
    return false;
  end if;

  create temp table if not exists tmp_inst_panels (id uuid primary key) on commit drop;
  truncate tmp_inst_panels;
  insert into tmp_inst_panels select p.id from public.panels p where p.installation_id = p_installation;

  -- Filas de otras instalaciones que nombran a esos paneles.
  create temp table if not exists tmp_foreign_purged (
    table_name text not null, id uuid not null, installation_id uuid not null, revision bigint not null
  ) on commit drop;
  truncate tmp_foreign_purged;
  with d as (
    delete from public.control_button_panels l
     using tmp_inst_panels t
     where l.panel_id = t.id and l.installation_id <> p_installation
    returning l.id, l.installation_id, l.revision)
  insert into tmp_foreign_purged select 'control_button_panels', id, installation_id, revision from d;
  with d as (
    delete from public.profile_panel_rules r
     using tmp_inst_panels t
     where r.panel_id = t.id and r.installation_id <> p_installation
    returning r.id, r.installation_id, r.revision)
  insert into tmp_foreign_purged select 'profile_panel_rules', id, installation_id, revision from d;
  with d as (
    delete from public.outputs o
     using tmp_inst_panels t
     where o.panel_id = t.id and o.installation_id <> p_installation
    returning o.id, o.installation_id, o.revision)
  insert into tmp_foreign_purged select 'outputs', id, installation_id, revision from d;
  with d as (
    delete from public.panel_call_settings s
     using tmp_inst_panels t
     where s.panel_id = t.id and s.installation_id <> p_installation
    returning s.id, s.installation_id, s.revision)
  insert into tmp_foreign_purged select 'panel_call_settings', id, installation_id, revision from d;

  delete from public.audit_log a using tmp_foreign_purged f
   where a.table_name = f.table_name and a.row_id = f.id;
  delete from public.sync_conflicts c using tmp_foreign_purged f where c.row_id = f.id;
  insert into public.purged_rows (id, table_name, installation_id)
  select id, table_name, installation_id from tmp_foreign_purged
  on conflict (id) do nothing;
  update public.installations i
     set purged_revision = m.max_revision
    from (select installation_id, max(revision) as max_revision
            from tmp_foreign_purged group by installation_id) m
   where i.id = m.installation_id
     and i.purged_revision < m.max_revision;

  -- Auditoría de las filas de esta instalación (audit_log no tiene installation_id).
  delete from public.audit_log a
   where (a.table_name = 'holders' and a.row_id in (select x.id from public.holders x where x.installation_id = p_installation))
      or (a.table_name = 'cards' and a.row_id in (select x.id from public.cards x where x.installation_id = p_installation))
      or (a.table_name = 'controls' and a.row_id in (select x.id from public.controls x where x.installation_id = p_installation))
      or (a.table_name = 'control_buttons' and a.row_id in (select x.id from public.control_buttons x where x.installation_id = p_installation))
      or (a.table_name = 'control_button_panels' and a.row_id in (select x.id from public.control_button_panels x where x.installation_id = p_installation))
      or (a.table_name = 'access_profiles' and a.row_id in (select x.id from public.access_profiles x where x.installation_id = p_installation))
      or (a.table_name = 'holder_profiles' and a.row_id in (select x.id from public.holder_profiles x where x.installation_id = p_installation))
      or (a.table_name = 'profile_panel_rules' and a.row_id in (select x.id from public.profile_panel_rules x where x.installation_id = p_installation))
      or (a.table_name = 'outputs' and a.row_id in (select x.id from public.outputs x where x.installation_id = p_installation))
      or (a.table_name = 'phones' and a.row_id in (select x.id from public.phones x where x.installation_id = p_installation))
      or (a.table_name = 'panel_call_settings' and a.row_id in (select x.id from public.panel_call_settings x where x.installation_id = p_installation));

  -- Filas que nombran a los paneles sin cascada (FK 'no action'), luego los paneles
  -- (arrastran access_logs, panel_commands, sync_conflicts, device_changes y panel_imports).
  delete from public.control_button_panels l where l.installation_id = p_installation;
  delete from public.profile_panel_rules r where r.installation_id = p_installation;
  delete from public.outputs o where o.installation_id = p_installation;
  delete from public.panel_call_settings s where s.installation_id = p_installation;
  delete from public.panels p using tmp_inst_panels t where p.id = t.id;

  -- El resto cae por la cascada de installation_id.
  delete from public.installations i where i.id = p_installation;
  return true;
end;
$$;


-- ---------------------------------------------------------------------------
-- Una configuración de llamadas por cada panel que ya tiene instalación
-- ---------------------------------------------------------------------------
-- Como servidor (sin auth.uid()): el trigger pone tenant_id y revisión.
select private.ensure_panel_call_settings(p.id, p.installation_id)
from public.panels p
where p.installation_id is not null
  and p.status in ('claimed', 'staging', 'awaiting_review', 'active')
order by p.installation_id, p.id;
