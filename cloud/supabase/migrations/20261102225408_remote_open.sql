-- remote_open: datos de la nube para la apertura remota (etapa 3).
--
-- * profile_panel_rules.allow_remote: la regla de un perfil en un panel permite (o no)
--   abrir sus salidas a distancia. Viaja al panel como permissions.allow_remote.
--   - push_permission: un panel v6 no lo envía; al editar una regla se conserva el valor
--     de la nube y al crearla vale false.
--   - import_rows: igual, false si el snapshot del panel no lo trae.
-- * panel_commands admite kind = 'remote_open' (abrir una salida para un titular):
--   - holder_id: el titular de la apertura, obligatorio en remote_open y de la misma
--     instalación que la orden;
--   - reason: el motivo de la decisión del panel (0..255), que llega con su resultado.
--   La orden remote_open usa el mismo índice de "una sola pendiente por salida" que
--   test_output: una prueba y una apertura no se ejecutan a la vez en la misma salida.
--
-- Las funciones se redefinen completas desde su última versión (push_permission de
-- 20261027070607_sync.sql e import_rows de 20261030225254_control_button_panels.sql);
-- solo cambia lo de allow_remote. `create or replace` conserva sus grants.

-- ---------------------------------------------------------------------------
-- profile_panel_rules.allow_remote
-- ---------------------------------------------------------------------------
alter table public.profile_panel_rules add column allow_remote boolean not null default false;

-- Igual que allow_rf: authenticated la escribe al crear y editar reglas (select ya es de
-- toda la tabla).
grant insert (allow_remote) on public.profile_panel_rules to authenticated;
grant update (allow_remote) on public.profile_panel_rules to authenticated;

-- ---------------------------------------------------------------------------
-- panel_commands: remote_open, holder_id y reason
-- ---------------------------------------------------------------------------
alter table public.panel_commands drop constraint panel_commands_kind_check;
alter table public.panel_commands
  add constraint panel_commands_kind_check check (kind in ('test_output', 'remote_open'));

alter table public.panel_commands add column holder_id uuid;
alter table public.panel_commands add column reason int;
alter table public.panel_commands
  add constraint panel_commands_holder_required_check check (kind <> 'remote_open' or holder_id is not null),
  add constraint panel_commands_reason_check check (reason between 0 and 255),
  -- El titular es de la instalación de la orden (MATCH SIMPLE: test_output va sin titular).
  add constraint panel_commands_holder_fkey foreign key (installation_id, holder_id)
    references public.holders (installation_id, id) on delete cascade;
create index panel_commands_installation_id_holder_id_idx
  on public.panel_commands (installation_id, holder_id);

grant select (holder_id, reason) on public.panel_commands to authenticated;

-- ---------------------------------------------------------------------------
-- push_permission: allow_remote opcional (panel v6)
-- ---------------------------------------------------------------------------
create or replace function private.push_permission(
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
           weekday_mask = (p_data ->> 'weekday_mask')::int,
           start_minute = (p_data ->> 'start_minute')::int,
           end_minute = (p_data ->> 'end_minute')::int,
           updated_at = p_ts, updated_by = p_author, origin = p_author
     where r.id = v_rule.id and r.installation_id = p_inst and r.panel_id = p_panel_id;
  else
    insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                            pin_reader_mask, allow_rf, allow_remote, weekday_mask, start_minute,
                                            end_minute, updated_at, updated_by, origin)
    values (p_inst, p_id, p_panel_id, (p_data ->> 'output_mask')::int, (p_data ->> 'card_reader_mask')::int,
            (p_data ->> 'pin_reader_mask')::int, (p_data ->> 'allow_rf')::boolean,
            coalesce((p_data ->> 'allow_remote')::boolean, false),
            (p_data ->> 'weekday_mask')::int, (p_data ->> 'start_minute')::int, (p_data ->> 'end_minute')::int,
            p_ts, p_author, p_author);
  end if;
  return jsonb_build_object('status', 'applied');
end;
$$;

-- ---------------------------------------------------------------------------
-- import_rows: allow_remote de cada permiso del snapshot (false si no viene)
-- ---------------------------------------------------------------------------
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
                                          pin_reader_mask, allow_rf, allow_remote, weekday_mask, start_minute,
                                          end_minute, updated_at, updated_by, origin)
  select p_inst, private.import_id(v_profiles, r.id), p_panel_id, r.output_mask, r.card_reader_mask,
         r.pin_reader_mask, r.allow_rf, coalesce(r.allow_remote, false), r.weekday_mask, r.start_minute,
         r.end_minute, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, output_mask int, card_reader_mask int, pin_reader_mask int, allow_rf boolean, allow_remote boolean,
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
end;
$$;
