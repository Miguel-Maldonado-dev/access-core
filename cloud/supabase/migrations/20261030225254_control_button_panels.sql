-- control_button_panels: vínculos botón–panel con la salida que el botón activa en cada panel.
--
-- Antes, control_buttons.output_index era la misma salida en todos los paneles de la
-- instalación y (control_id, button) era único en toda la nube. Ahora:
--   * cada botón se vincula a los paneles que lo reciben, con su output_index por panel
--     (nulo = el panel lo tiene sin salida; sin vínculo = el panel no lo recibe);
--   * un solo vínculo vivo por (button_id, panel_id);
--   * el número de botón es único POR PANEL: entre los vínculos vivos de un panel cuyos
--     botones están vivos, (control_id, button) no se repite (lo exige el panel local).
--     Dos botones vivos del mismo control pueden compartir número en paneles distintos;
--   * control_buttons pierde output_index y el índice único (control_id, button).
--
-- control_button_panels es una tabla replicada como las de 0002_replicated: tenant_id y
-- revision los pone private.replicated_before_write, entra en la auditoría, en RLS por
-- tenant y en los grants por columna. Su panel debe ser de la misma instalación
-- (private.check_panel_installation, como outputs) y el borrado lógico de un botón
-- borra sus vínculos (private.replicated_soft_delete_cascade).
--
-- Datos actuales: cada botón vivo se vincula a todos los paneles de su instalación
-- (reclamados, en revisión o activos) con su output_index, firmado como servidor con
-- updated_by = 'system:migracion' y origin = 'cloud'.
--
-- Push del panel (apply_panel_change): control_buttons y el borrado de controls se aplican
-- por panel (ver la sección "Push desde el panel con semántica por panel", al final).

-- ---------------------------------------------------------------------------
-- Tabla
-- ---------------------------------------------------------------------------
-- Destino de la FK compuesta: un vínculo solo apunta a botones de su instalación.
alter table public.control_buttons
  add constraint control_buttons_installation_id_id_key unique (installation_id, id);

create table public.control_button_panels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  button_id uuid not null,
  panel_id uuid not null references public.panels (id),
  output_index int check (output_index between 0 and 3),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint control_button_panels_button_fkey foreign key (installation_id, button_id)
    references public.control_buttons (installation_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------
-- Un solo vínculo vivo por botón y panel (un borrado lógico libera el par). También
-- sirve a la búsqueda de los vínculos de un botón (unicidad por panel).
create unique index control_button_panels_button_panel_live_key
  on public.control_button_panels (button_id, panel_id) where deleted_at is null;
-- FK compuesta hacia el botón (también la usa la cascada lógica) y FK hacia panels.
create index control_button_panels_installation_id_button_id_idx
  on public.control_button_panels (installation_id, button_id);
create index control_button_panels_panel_id_idx on public.control_button_panels (panel_id);
-- Sincronización (registros con revision > N) y columna de la política.
create index control_button_panels_installation_id_revision_idx
  on public.control_button_panels (installation_id, revision);
create index control_button_panels_tenant_id_idx on public.control_button_panels (tenant_id);

-- ---------------------------------------------------------------------------
-- Escritura replicada, panel de la misma instalación y cascada lógica
-- ---------------------------------------------------------------------------
-- Un vínculo vivo no puede apuntar a un botón borrado o de otra instalación.
create trigger control_button_panels_before_write before insert or update on public.control_button_panels
  for each row execute function private.replicated_before_write('button_id', 'control_buttons');

create trigger control_button_panels_panel_installation before insert or update of panel_id, installation_id
  on public.control_button_panels
  for each row execute function private.check_panel_installation();

-- Borrar un botón borra sus vínculos (con el autor y la hora del borrado del botón).
create trigger control_buttons_soft_delete_cascade after update of deleted_at on public.control_buttons
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.replicated_soft_delete_cascade('control_button_panels', 'button_id');

-- ---------------------------------------------------------------------------
-- Auditoría, RLS y grants (como las demás tablas replicadas)
-- ---------------------------------------------------------------------------
alter table public.audit_log drop constraint audit_log_table_name_check;
alter table public.audit_log add constraint audit_log_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'control_button_panels',
    'access_profiles', 'holder_profiles', 'profile_panel_rules', 'outputs'));

create trigger control_button_panels_audit after insert or update on public.control_button_panels
  for each row execute function private.replicated_audit();

alter table public.control_button_panels enable row level security;
create policy control_button_panels_select on public.control_button_panels for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy control_button_panels_insert on public.control_button_panels for insert to authenticated
  with check ((select private.is_member(tenant_id)));
create policy control_button_panels_update on public.control_button_panels for update to authenticated
  using ((select private.is_member(tenant_id)))
  with check ((select private.is_member(tenant_id)));

-- Se retiran los defaults de Supabase (incluido TRUNCATE, que ignora RLS). authenticated:
-- el botón y el panel solo al insertar (un vínculo no cambia de botón ni de panel); se
-- actualiza la salida o se borra lógicamente. Nunca id, tenant_id, revision, updated_at,
-- updated_by ni origin (los pone el trigger).
revoke all on public.control_button_panels from public, anon, authenticated;
grant all on public.control_button_panels to service_role;
grant select on public.control_button_panels to authenticated;
grant insert (installation_id, button_id, panel_id, output_index) on public.control_button_panels to authenticated;
grant update (output_index, deleted_at) on public.control_button_panels to authenticated;

-- ---------------------------------------------------------------------------
-- Migración de los datos actuales
-- ---------------------------------------------------------------------------
-- Cada botón vivo queda vinculado a todos los paneles de su instalación con su
-- output_index actual, para que nada deje de funcionar. Escribe como servidor (sin
-- auth.uid()): el trigger respeta updated_by y origin, pone tenant_id y revision.
insert into public.control_button_panels (installation_id, button_id, panel_id, output_index,
                                          updated_at, updated_by, origin)
select b.installation_id, b.id, p.id, b.output_index, now(), 'system:migracion', 'cloud'
from public.control_buttons b
join public.panels p
  on p.installation_id = b.installation_id
 and p.status in ('claimed', 'staging', 'awaiting_review', 'active')
where b.deleted_at is null
order by b.installation_id, b.id, p.id;

-- ---------------------------------------------------------------------------
-- control_buttons pierde output_index y la unicidad por control
-- ---------------------------------------------------------------------------
revoke insert (output_index), update (output_index) on public.control_buttons from authenticated;
alter table public.control_buttons drop column output_index;
drop index public.control_buttons_control_button_live_key;

-- ---------------------------------------------------------------------------
-- claim_panel: además borra los vínculos vivos del panel en la instalación anterior
-- ---------------------------------------------------------------------------
-- Igual a la versión de 20261028165920_claim_panel_neutral_author (misma firma, autor
-- neutro 'system:reclamo'), más el borrado lógico de los control_button_panels vivos de
-- ese panel que son de otra instalación. Si vuelve a la misma instalación no se toca nada.
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

  return v_panel;
end;
$$;

revoke execute on function public.claim_panel(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_panel(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Unicidad del número de botón por panel
-- ---------------------------------------------------------------------------
-- AFTER INSERT OR UPDATE de control_button_panels (alta, borrado o cambio de panel de un
-- vínculo) y AFTER UPDATE de control_buttons (número, control o borrado de un botón),
-- solo cuando la fila queda viva. Falla con unique_violation y la restricción
-- 'control_button_panels_panel_button_live_key' (apply_panel_change lo traduce a
-- `duplicado`) si en algún panel del vínculo hay otro botón vivo, vinculado y vivo, del
-- mismo control con el mismo número.
-- Es AFTER: corre después de replicated_before_write, que ya bloqueó la instalación
-- (las escrituras de una instalación se serializan y esta consulta ve las confirmadas), y
-- ve completas las sentencias de varias filas.
-- Es security definer para ver todos los vínculos del panel aunque RLS los oculte.
create function private.check_button_panel_unique()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_panel uuid;
begin
  if tg_table_name = 'control_button_panels' then
    select l.panel_id into v_panel
    from public.control_buttons b
    join public.control_buttons o
      on o.installation_id = b.installation_id and o.control_id = b.control_id
     and o.button = b.button and o.id <> b.id and o.deleted_at is null
    join public.control_button_panels l
      on l.button_id = o.id and l.panel_id = new.panel_id and l.deleted_at is null
    where b.id = new.button_id and b.deleted_at is null
    limit 1;
  else
    select l.panel_id into v_panel
    from public.control_button_panels mine
    join public.control_buttons o
      on o.installation_id = new.installation_id and o.control_id = new.control_id
     and o.button = new.button and o.id <> new.id and o.deleted_at is null
    join public.control_button_panels l
      on l.button_id = o.id and l.panel_id = mine.panel_id and l.deleted_at is null
    where mine.button_id = new.id and mine.deleted_at is null
    limit 1;
  end if;

  if v_panel is not null then
    raise exception 'El número de botón ya está en uso en ese control para este panel.'
      using errcode = 'unique_violation', constraint = 'control_button_panels_panel_button_live_key',
            -- PostgREST no expone `constraint`; la nube lo reconoce por `details`.
            detail = 'control_button_panels_panel_button_live_key';
  end if;
  return null;
end;
$$;

revoke execute on function private.check_button_panel_unique() from public;

create trigger control_button_panels_panel_button_unique
  after insert or update of deleted_at, panel_id on public.control_button_panels
  for each row when (new.deleted_at is null)
  execute function private.check_button_panel_unique();
create trigger control_buttons_panel_button_unique
  after update of button, control_id, deleted_at on public.control_buttons
  for each row when (new.deleted_at is null)
  execute function private.check_button_panel_unique();

-- ---------------------------------------------------------------------------
-- Ajuste mínimo de las funciones que nombraban control_buttons.output_index
-- ---------------------------------------------------------------------------
-- Iguales a las de 20261027070607_sync.sql salvo que ya no leen ni escriben
-- control_buttons.output_index. Todavía no vinculan el botón a ningún panel: la
-- semántica por panel del push (Tarea 2) y de la importación (Tarea 4) se agrega
-- después en esta misma migración. create or replace conserva sus grants.

create or replace function private.push_row(
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

  insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_at, updated_by, origin)
  select private.import_id(v_profiles, r.id), p_inst, r.name, r.local_permission_id, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, name text, local_permission_id int);

  insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                          pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute,
                                          updated_at, updated_by, origin)
  select p_inst, private.import_id(v_profiles, r.id), p_panel_id, r.output_mask, r.card_reader_mask,
         r.pin_reader_mask, r.allow_rf, r.weekday_mask, r.start_minute, r.end_minute, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, output_mask int, card_reader_mask int, pin_reader_mask int, allow_rf boolean, weekday_mask int,
    start_minute int, end_minute int);

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

-- ---------------------------------------------------------------------------
-- Push desde el panel con semántica por panel (control_buttons y borrado de controls)
-- ---------------------------------------------------------------------------
-- Lo que sube el panel P afecta solo a P:
--   * control_buttons, upsert de un id que la nube tiene vivo: la salida va al vínculo
--     (botón, P), con LWW sobre el updated_at del vínculo (un vínculo borrado más viejo que
--     el cambio se revive). Solo si control_id, button o rf_code difieren de la nube, el
--     registro compartido va además por push_row con LWW, como antes; si no, no se toca.
--     Si el botón está borrado en la nube, push_row responde superseded y no se revive
--     nada (el borrado de la nube es definitivo, como en las demás tablas);
--   * control_buttons, upsert de un id nuevo: se crea el botón y su vínculo solo con P. Si
--     su rf_code ya lo tiene un botón vivo B' de un control del MISMO titular, se fusiona:
--     P queda vinculado a B' con esa salida, se responde rejected/`fusionado` (P borra su
--     copia y recibe B' en el siguiente pull) y, si el control que mandó P se quedó sin
--     botones vivos y lo creó P, se borra. Con otro titular, `duplicado` como antes;
--   * control_buttons, delete: borra el vínculo (botón, P) con LWW contra el más nuevo entre
--     el updated_at del vínculo y el del botón (una edición compartida en la nube, como el
--     rf_code, más nueva que el borrado gana: superseded); si el botón se queda sin vínculos
--     vivos, se borra (libera el rf_code). El control no se borra: P sube un cambio de código
--     como borrar y crear, y el alta necesita el control vivo;
--   * controls, delete: borra los vínculos con P de los botones vivos del control (LWW por
--     botón, con la misma regla: vínculo o botón), borra los botones que se quedaron sin
--     vínculos y borra el control (LWW,
--     con push_row) solo si ya no le queda ningún botón vivo con vínculo vivo a otro panel
--     (los botones vivos sin vínculos no lo impiden: la cascada los borra).
-- Los conflictos de un vínculo se registran con table_name = 'control_buttons' (vocabulario
-- del contrato) y cloud_version = private.button_panel_version.

-- La unicidad por panel también se revisa si un vínculo cambia de botón (escritura del
-- servidor: authenticated no puede cambiar button_id).
drop trigger control_button_panels_panel_button_unique on public.control_button_panels;
create trigger control_button_panels_panel_button_unique
  after insert or update of deleted_at, panel_id, button_id on public.control_button_panels
  for each row when (new.deleted_at is null)
  execute function private.check_button_panel_unique();

-- Versión de la nube de un botón PARA UN PANEL (cloud_version de los conflictos de
-- control_buttons): la fila del botón con panel_id, linked (si tiene vínculo vivo con ese
-- panel) y output_index (la salida de ese vínculo; nulo sin vínculo o sin salida).
create function private.button_panel_version(p_button_id uuid, p_panel_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(b) || jsonb_build_object(
    'panel_id', p_panel_id, 'linked', l.id is not null, 'output_index', l.output_index)
  from public.control_buttons b
  left join public.control_button_panels l
    on l.button_id = b.id and l.panel_id = p_panel_id and l.deleted_at is null
  where b.id = p_button_id;
$$;

-- Botón vivo, vinculado y vivo en el panel, que ocupa (control, número): cloud_version del
-- choque con control_button_panels_panel_button_live_key.
create function private.button_occupant_version(p_inst uuid, p_panel_id uuid, p_control_id uuid, p_button int)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.button_panel_version(o.id, p_panel_id)
  from public.control_buttons o
  join public.control_button_panels l
    on l.button_id = o.id and l.panel_id = p_panel_id and l.deleted_at is null
  where o.installation_id = p_inst
    and o.control_id = p_control_id
    and o.button = p_button
    and o.deleted_at is null
  limit 1;
$$;

-- Crea, actualiza o revive el vínculo (botón, panel) con la salida p_output.
-- LWW contra el vínculo más reciente de ese par (vivo o, si no hay, el último borrado):
-- en empate gana la nube. Con p_force (fusión) se escribe sin LWW: P acaba de dar de alta
-- ese control y debe recibirlo en su siguiente pull. Un vínculo vivo con la misma salida
-- no se reescribe (salvo con p_force). Devuelve {status, conflict?}.
create function private.push_button_link(
  p_inst uuid,
  p_panel_id uuid,
  p_button_id uuid,
  p_ts timestamptz,
  p_author text,
  p_output int,
  p_force boolean
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_link public.control_button_panels;
begin
  select * into v_link
  from public.control_button_panels l
  where l.button_id = p_button_id and l.panel_id = p_panel_id and l.installation_id = p_inst
  order by (l.deleted_at is null) desc, l.updated_at desc
  limit 1;

  if v_link.id is not null and not p_force and v_link.updated_at >= p_ts then
    return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
      'kind', 'lww', 'cloud_version', private.button_panel_version(p_button_id, p_panel_id),
      'resolution', case when v_link.deleted_at is null
        then 'Gana la nube: su versión es más reciente.'
        else 'Gana la nube: el vínculo con este panel está borrado.' end));
  end if;

  if v_link.id is null then
    insert into public.control_button_panels (installation_id, button_id, panel_id, output_index,
                                              updated_at, updated_by, origin)
    values (p_inst, p_button_id, p_panel_id, p_output, p_ts, p_author, p_author);
  elsif p_force or v_link.deleted_at is not null or v_link.output_index is distinct from p_output then
    update public.control_button_panels l
       set output_index = p_output, deleted_at = null, updated_at = p_ts, updated_by = p_author, origin = p_author
     where l.id = v_link.id;
  end if;
  return jsonb_build_object('status', 'applied');
end;
$$;

-- Borra el botón si está vivo y ya no tiene vínculos vivos (un botón sin paneles no hace
-- nada y retendría su rf_code). La cascada borra sus vínculos (ya borrados).
create function private.delete_unlinked_button(p_inst uuid, p_button_id uuid, p_ts timestamptz, p_author text)
returns void
language sql
volatile
set search_path = ''
as $$
  update public.control_buttons b
     set deleted_at = now(), updated_at = p_ts, updated_by = p_author, origin = p_author
   where b.id = p_button_id
     and b.installation_id = p_inst
     and b.deleted_at is null
     and not exists (select 1 from public.control_button_panels l
                     where l.button_id = b.id and l.deleted_at is null);
$$;

-- Un cambio de control_buttons del panel p_panel_id (ver el encabezado de esta sección).
-- Devuelve {status, reason?, conflict?} como push_row; los choques de unicidad y de
-- referencias que no maneja aquí los traduce apply_panel_change.
create function private.push_control_button(
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
  v_button public.control_buttons;
  v_link public.control_button_panels;
  v_other public.control_buttons;
  v_out jsonb;
  v_link_out jsonb;
  v_control_id uuid := (p_data ->> 'control_id')::uuid;
  v_output int := (p_data ->> 'output_id')::int;
  v_holder uuid;
  v_other_holder uuid;
begin
  select * into v_button
  from public.control_buttons b
  where b.id = p_id and b.installation_id = p_inst;
  if v_button.id is null and exists (select 1 from public.control_buttons b where b.id = p_id) then
    -- El id es de otra instalación.
    return jsonb_build_object('status', 'rejected', 'reason', 'no encontrado');
  end if;

  if p_op = 'delete' then
    if v_button.id is null or v_button.deleted_at is not null then
      return jsonb_build_object('status', 'applied');
    end if;
    select * into v_link
    from public.control_button_panels l
    where l.button_id = p_id and l.panel_id = p_panel_id and l.deleted_at is null;
    if v_link.id is null then
      return jsonb_build_object('status', 'applied');
    end if;
    -- LWW contra el vínculo y contra el botón: el updated_at del botón solo cambia con
    -- ediciones compartidas (control, número o rf_code), no con la salida de un panel.
    if greatest(v_link.updated_at, v_button.updated_at) >= p_ts then
      return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
        'kind', 'lww', 'cloud_version', private.button_panel_version(p_id, p_panel_id),
        'resolution', 'Gana la nube: su versión es más reciente.'));
    end if;
    update public.control_button_panels l
       set deleted_at = now(), updated_at = p_ts, updated_by = p_author, origin = p_author
     where l.id = v_link.id;
    perform private.delete_unlinked_button(p_inst, p_id, p_ts, p_author);
    return jsonb_build_object('status', 'applied');
  end if;

  if v_button.id is not null then
    if v_button.deleted_at is null
       and (v_button.control_id, v_button.button, v_button.rf_code)
           is not distinct from (v_control_id, (p_data ->> 'button')::int, (p_data ->> 'rf_code')::bigint) then
      -- Solo cambió la salida de este panel (el caso normal: el panel cambia el código o el
      -- número como borrar y crear). El registro compartido no se toca: ni su revisión ni
      -- su updated_at, que haría perder por LWW el cambio de salida de otro panel.
      v_out := private.push_button_link(p_inst, p_panel_id, p_id, p_ts, p_author, v_output, false);
      if v_out ? 'conflict' then
        v_out := jsonb_set(v_out, '{conflict,cloud_version}',
                           coalesce(private.button_panel_version(p_id, p_panel_id), 'null'::jsonb));
      end if;
      return v_out;
    end if;
    -- Registro compartido (control, número y código) con push_row; un botón borrado en la
    -- nube no se revive.
    v_out := private.push_row('control_buttons', p_inst, p_panel_id, 'upsert', p_id, p_ts, p_author, p_data);
    if v_out ->> 'status' = 'applied' or (v_out ->> 'status' = 'superseded' and v_button.deleted_at is null) then
      -- La salida de este panel, con su propio LWW: si cualquiera de los dos pierde, el
      -- cambio queda superseded y el panel recibe la proyección vigente como current.
      v_link_out := private.push_button_link(p_inst, p_panel_id, p_id, p_ts, p_author, v_output, false);
      if v_out ->> 'status' = 'applied' then
        v_out := v_link_out;
      end if;
    end if;
    if v_out ? 'conflict' then
      v_out := jsonb_set(v_out, '{conflict,cloud_version}',
                         coalesce(private.button_panel_version(p_id, p_panel_id), 'null'::jsonb));
    end if;
    return v_out;
  end if;

  -- Alta. ¿El código RF ya lo tiene un botón vivo de un control del mismo titular?
  select * into v_other
  from public.control_buttons b
  where b.installation_id = p_inst and b.rf_code = (p_data ->> 'rf_code')::bigint and b.deleted_at is null;
  if v_other.id is not null then
    select c.holder_id into v_holder
    from public.controls c
    where c.id = v_control_id and c.installation_id = p_inst and c.deleted_at is null;
    select c.holder_id into v_other_holder
    from public.controls c
    where c.id = v_other.control_id;
    if v_holder is not null and v_holder = v_other_holder then
      begin
        perform private.push_button_link(p_inst, p_panel_id, v_other.id, p_ts, p_author, v_output, true);
      exception
        when unique_violation then
          -- Otro botón de ese control ya ocupa en P el número de B'.
          return jsonb_build_object('status', 'rejected', 'reason', 'duplicado', 'conflict', jsonb_build_object(
            'kind', 'unique',
            'cloud_version', private.button_occupant_version(p_inst, p_panel_id, v_other.control_id, v_other.button),
            'resolution', 'Rechazado: duplicado.'));
      end;
      -- El control que P creó para este alta se borra si se quedó vacío.
      update public.controls c
         set deleted_at = now(), updated_at = p_ts, updated_by = p_author, origin = p_author
       where c.id = v_control_id
         and c.installation_id = p_inst
         and c.deleted_at is null
         and c.origin = p_author
         and not exists (select 1 from public.control_buttons b
                         where b.installation_id = p_inst and b.control_id = c.id and b.deleted_at is null);
      return jsonb_build_object('status', 'rejected', 'reason', 'fusionado');
    end if;
  end if;

  -- Botón nuevo (con otro titular, push_row choca con control_buttons_rf_code_live_key) y
  -- su vínculo solo con P (puede chocar con control_button_panels_panel_button_live_key).
  v_out := private.push_row('control_buttons', p_inst, p_panel_id, 'upsert', p_id, p_ts, p_author, p_data);
  if v_out ->> 'status' = 'applied' then
    perform private.push_button_link(p_inst, p_panel_id, p_id, p_ts, p_author, v_output, false);
  end if;
  return v_out;
end;
$$;

-- Borrado de un control desde el panel p_panel_id (ver el encabezado de esta sección).
-- Riesgos residuales (los corrige la conciliación diaria, cuyas sumas usan el mismo filtro):
--   * si el borrado del botón y el del control caen en páginas de push distintas y un vínculo
--     de P gana el LWW, el `current` del botón se omite en el panel (skip_missing_parents,
--     falta su control) y, como el vínculo no cambia de revisión, P recupera el botón en la
--     conciliación;
--   * si un botón cambia de control_id, el feed solo revisa su control nuevo: el control
--     anterior que queda vacío no se reenvía como upsert a los otros paneles hasta la conciliación.
create function private.push_control_delete(
  p_inst uuid,
  p_panel_id uuid,
  p_id uuid,
  p_ts timestamptz,
  p_author text
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_control public.controls;
  v_link record;
  v_lost boolean := false;
begin
  select * into v_control
  from public.controls c
  where c.id = p_id and c.installation_id = p_inst;
  if v_control.id is null then
    if exists (select 1 from public.controls c where c.id = p_id) then
      return jsonb_build_object('status', 'rejected', 'reason', 'no encontrado');
    end if;
    return jsonb_build_object('status', 'applied');
  end if;
  if v_control.deleted_at is not null then
    return jsonb_build_object('status', 'applied');
  end if;

  for v_link in
    select l.id, l.button_id, greatest(l.updated_at, b.updated_at) as updated_at
    from public.control_buttons b
    join public.control_button_panels l
      on l.button_id = b.id and l.panel_id = p_panel_id and l.deleted_at is null
    where b.installation_id = p_inst and b.control_id = p_id and b.deleted_at is null
    order by b.id
  loop
    if v_link.updated_at >= p_ts then
      v_lost := true;
      continue;
    end if;
    update public.control_button_panels l
       set deleted_at = now(), updated_at = p_ts, updated_by = p_author, origin = p_author
     where l.id = v_link.id;
    perform private.delete_unlinked_button(p_inst, v_link.button_id, p_ts, p_author);
  end loop;

  if v_lost then
    -- Un botón (o su vínculo con P) más nuevo que el borrado gana: el control sigue para P.
    return jsonb_build_object('status', 'superseded', 'conflict', jsonb_build_object(
      'kind', 'lww', 'cloud_version', to_jsonb(v_control),
      'resolution', 'Gana la nube: un botón o su vínculo con este panel es más reciente.'));
  end if;
  if exists (select 1 from public.control_buttons b
             join public.control_button_panels l on l.button_id = b.id and l.deleted_at is null
             where b.installation_id = p_inst and b.control_id = p_id and b.deleted_at is null) then
    -- Sigue vivo para los otros paneles; P deja de recibirlo.
    return jsonb_build_object('status', 'applied');
  end if;
  -- Sin botones vinculados a otros paneles: se borra el control, y la cascada borra los
  -- botones vivos que no tenían ningún vínculo.
  return private.push_row('controls', p_inst, p_panel_id, 'delete', p_id, p_ts, p_author, null);
end;
$$;

revoke execute on function private.button_panel_version(uuid, uuid) from public;
revoke execute on function private.button_occupant_version(uuid, uuid, uuid, int) from public;
revoke execute on function private.push_button_link(uuid, uuid, uuid, timestamptz, text, int, boolean) from public;
revoke execute on function private.delete_unlinked_button(uuid, uuid, timestamptz, text) from public;
revoke execute on function private.push_control_button(uuid, uuid, text, uuid, timestamptz, text, jsonb) from public;
revoke execute on function private.push_control_delete(uuid, uuid, uuid, timestamptz, text) from public;
grant execute on function private.button_panel_version(uuid, uuid) to service_role;
grant execute on function private.button_occupant_version(uuid, uuid, uuid, int) to service_role;
grant execute on function private.push_button_link(uuid, uuid, uuid, timestamptz, text, int, boolean) to service_role;
grant execute on function private.delete_unlinked_button(uuid, uuid, timestamptz, text) to service_role;
grant execute on function private.push_control_button(uuid, uuid, text, uuid, timestamptz, text, jsonb) to service_role;
grant execute on function private.push_control_delete(uuid, uuid, uuid, timestamptz, text) to service_role;

-- unique_conflict_version recibe además el panel: el número de botón es único por panel.
-- Rama nueva para control_button_panels_panel_button_live_key: el botón vivo que ocupa ese
-- número del control en ese panel, con su vínculo (private.button_panel_version).
drop function private.unique_conflict_version(uuid, text, jsonb);
create function private.unique_conflict_version(p_inst uuid, p_panel_id uuid, p_constraint text, p_data jsonb)
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
    when 'holders_pin_lookup_live_key' then
      (select private.sync_version(to_jsonb(h)) from public.holders h
        where h.installation_id = p_inst and h.pin_lookup = p_data ->> 'pin_lookup'
          and h.deleted_at is null)
  end;
$$;

revoke execute on function private.unique_conflict_version(uuid, uuid, text, jsonb) from public;
grant execute on function private.unique_conflict_version(uuid, uuid, text, jsonb) to service_role;

-- apply_panel_change: igual a la de 20261027070607_sync.sql salvo que control_buttons y el
-- delete de controls van por las funciones por panel de arriba, y unique_conflict_version
-- recibe el panel. create or replace conserva sus grants.
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
                     'holder_permissions', 'outputs')
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

-- ---------------------------------------------------------------------------
-- Importación de un panel con vínculos botón–panel
-- ---------------------------------------------------------------------------
-- Igual a la versión de arriba, más los vínculos con el panel que importa: p_plan trae
-- control_button_links [{button_id, output_index}], uno por cada botón que queda en la
-- nube y que el panel tenía (uno del plan, por el id del panel, que se traduce con
-- import_id; o uno vivo de la instalación que la nube ya tenía con el mismo titular, que
-- el servidor nunca repite como id de un botón del plan). Los botones de la nube que el
-- panel no tenía no se le vinculan. Un vínculo vivo que ya existe con ese panel (un panel
-- en revisión al migrar los datos) solo cambia de salida; los demás se dan de alta. El
-- autor y el origen son p_author, como en el resto del plan.
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
                                          pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute,
                                          updated_at, updated_by, origin)
  select p_inst, private.import_id(v_profiles, r.id), p_panel_id, r.output_mask, r.card_reader_mask,
         r.pin_reader_mask, r.allow_rf, r.weekday_mask, r.start_minute, r.end_minute, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, output_mask int, card_reader_mask int, pin_reader_mask int, allow_rf boolean, weekday_mask int,
    start_minute int, end_minute int);

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
