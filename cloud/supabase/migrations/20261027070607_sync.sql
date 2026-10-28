-- 0004_sync: subida de cambios de los paneles (N7), importación al vincular (N8) y logs de
-- acceso con su retención (N9).
-- Tablas: device_changes (idempotencia por change_id), sync_conflicts (conflictos
-- resueltos, para revisarlos) y panel_imports (snapshot de un panel en revisión).
-- Funciones: public.apply_panel_change, que aplica UN cambio de un panel en una
-- transacción; public.import_panel_snapshot, public.stage_panel_import y
-- public.confirm_panel_import, que importan la base de un panel recién vinculado; y sus
-- auxiliares en `private`.
--
-- Quién escribe: solo el servidor (llave secreta), a través de esas funciones.
-- authenticated lee sync_conflicts de sus tenants; device_changes y panel_imports no le
-- son visibles (la revisión de la importación lee el diff desde el servidor).
-- device_changes y sync_conflicts no guardan el PIN (ni en claro, ni cifrado, ni
-- pin_lookup); panel_imports lo guarda solo cifrado, como holders.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
-- Resultado de cada cambio ya aplicado: un change_id repetido devuelve este resultado
-- sin volver a aplicarse. result = {status, revision?, reason?}; el `current` de la
-- respuesta se calcula de nuevo al repetir (llevaría el PIN).
create table public.device_changes (
  panel_id uuid not null references public.panels (id) on delete cascade,
  change_id text not null check (length(change_id) between 1 and 64),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (panel_id, change_id)
);

-- table_name usa el vocabulario del contrato (tablas locales del panel) y row_id es el
-- `id` del contrato: el perfil en permissions y el holder_profile en holder_permissions.
-- cloud_version y panel_version nunca incluyen el PIN (a lo sumo has_pin).
create table public.sync_conflicts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  panel_id uuid not null references public.panels (id) on delete cascade,
  table_name text not null check (table_name in ('holders', 'cards', 'controls', 'control_buttons',
    'permissions', 'holder_permissions', 'outputs')),
  row_id uuid not null,
  kind text not null check (kind in ('lww', 'unique', 'skew')),
  cloud_version jsonb,
  panel_version jsonb,
  resolution text not null,
  created_at timestamptz not null default now()
);

-- Snapshot que subió un panel en staging cuando su instalación ya tenía datos, con el
-- diff para que un administrador elija qué importar. Existe mientras el panel está en
-- awaiting_review: confirm_panel_import la borra (no se conservan datos personales de más).
-- snapshot usa el vocabulario del contrato ({tabla: [{id, data}]}), salvo el PIN de
-- holders: va cifrado (pin_ciphertext) con su pin_lookup, nunca en claro. diff nunca
-- trae el PIN (solo has_pin).
create table public.panel_imports (
  panel_id uuid primary key references public.panels (id) on delete cascade,
  snapshot jsonb not null,
  diff jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------
-- device_changes(panel_id) y panel_imports(panel_id) ya los cubren sus llaves primarias.
-- Interfaz de conflictos: los de una instalación, del más reciente al más viejo.
create index sync_conflicts_installation_id_created_at_idx
  on public.sync_conflicts (installation_id, created_at desc);
create index sync_conflicts_tenant_id_idx on public.sync_conflicts (tenant_id);
create index sync_conflicts_panel_id_idx on public.sync_conflicts (panel_id);

-- ---------------------------------------------------------------------------
-- Auxiliares (security invoker; solo service_role los ejecuta, desde apply_panel_change)
-- ---------------------------------------------------------------------------

-- Fila de la nube sin el PIN: lo que se guarda como cloud_version.
create function private.sync_version(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_row - 'pin_ciphertext' - 'pin_lookup';
$$;

-- Aplica un cambio a una tabla de la nube con un registro por fila del contrato:
-- holders, cards, controls, control_buttons, holder_profiles y outputs (de ese panel).
-- p_data trae las columnas de la nube (el PIN ya cifrado y su pin_lookup; en
-- holder_profiles, `permission_id`, que aquí se traduce al perfil vivo).
-- Devuelve {status, reason?, conflict?: {kind, cloud_version, resolution}}.
-- Los errores de unicidad y de referencias los traduce apply_panel_change.
create function private.push_row(
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
    when 'control_buttons' then array['control_id', 'button', 'rf_code', 'output_index']
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

-- Aplica un cambio de `permissions`: el id es el del perfil; `name` va al perfil (de
-- toda la instalación) y las máscaras, días y horario a la regla de ESE panel.
-- Para LWW la versión de la nube es la del perfil y la última regla de ese panel (una
-- regla borrada también cuenta: se proyecta con máscaras en 0).
create function private.push_permission(
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
           weekday_mask = (p_data ->> 'weekday_mask')::int,
           start_minute = (p_data ->> 'start_minute')::int,
           end_minute = (p_data ->> 'end_minute')::int,
           updated_at = p_ts, updated_by = p_author, origin = p_author
     where r.id = v_rule.id and r.installation_id = p_inst and r.panel_id = p_panel_id;
  else
    insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                            pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute,
                                            updated_at, updated_by, origin)
    values (p_inst, p_id, p_panel_id, (p_data ->> 'output_mask')::int, (p_data ->> 'card_reader_mask')::int,
            (p_data ->> 'pin_reader_mask')::int, (p_data ->> 'allow_rf')::boolean,
            (p_data ->> 'weekday_mask')::int, (p_data ->> 'start_minute')::int, (p_data ->> 'end_minute')::int,
            p_ts, p_author, p_author);
  end if;
  return jsonb_build_object('status', 'applied');
end;
$$;

-- Registro vivo de la nube que ya tiene el valor único con el que chocó el cambio
-- (sin el PIN), para cloud_version del conflicto `unique`.
create function private.unique_conflict_version(p_inst uuid, p_constraint text, p_data jsonb)
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
    when 'holders_pin_lookup_live_key' then
      (select private.sync_version(to_jsonb(h)) from public.holders h
        where h.installation_id = p_inst and h.pin_lookup = p_data ->> 'pin_lookup'
          and h.deleted_at is null)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Aplicación atómica de un cambio del panel (la llama POST /changes con la llave secreta)
-- ---------------------------------------------------------------------------
-- En una sola transacción:
--   1. bloquea la instalación del panel (for no key update): las escrituras de una
--      instalación se serializan y un change_id repetido espera al primero;
--   2. si el change_id ya se aplicó, devuelve el resultado guardado sin aplicar nada;
--   3. con p_clock_skewed (updated_at más de MAX_CLOCK_SKEW_S en el futuro, lo decide
--      el servidor de Next.js) usa now() y registra un conflicto `skew`;
--   4. aplica el cambio con LWW (en empate gana la nube), escribiendo como servidor:
--      updated_at = el del cambio, updated_by = origin = 'panel:<panel_code>';
--   5. traduce los choques de unicidad (`duplicado`, con conflicto `unique`), los ids
--      de otra instalación (`no encontrado`) y los padres inexistentes o borrados
--      (`relacionado no existe`) a `rejected`, deshaciendo lo que se hubiera escrito;
--   6. guarda el resultado en device_changes.
-- p_data trae las columnas de la nube (el PIN ya cifrado); p_panel_version, la versión
-- del panel para los conflictos, sin PIN. Ninguno de los dos se guarda con el PIN.
-- Devuelve {status, revision?, reason?}: revision es installations.revision tras el
-- cambio, solo si quedó `applied` y escribió algo.
-- Va en public porque PostgREST no expone `private`; es security invoker y solo
-- service_role puede ejecutarla.
create function public.apply_panel_change(
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
          'cloud_version', private.unique_conflict_version(v_inst, v_constraint, p_data),
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

revoke execute on function private.sync_version(jsonb) from public;
revoke execute on function private.push_row(text, uuid, uuid, text, uuid, timestamptz, text, jsonb) from public;
revoke execute on function private.push_permission(uuid, uuid, text, uuid, timestamptz, text, jsonb) from public;
revoke execute on function private.unique_conflict_version(uuid, text, jsonb) from public;
grant execute on function private.sync_version(jsonb) to service_role;
grant execute on function private.push_row(text, uuid, uuid, text, uuid, timestamptz, text, jsonb) to service_role;
grant execute on function private.push_permission(uuid, uuid, text, uuid, timestamptz, text, jsonb) to service_role;
grant execute on function private.unique_conflict_version(uuid, text, jsonb) to service_role;

revoke execute on function public.apply_panel_change(uuid, text, text, text, uuid, timestamptz, boolean, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_panel_change(uuid, text, text, text, uuid, timestamptz, boolean, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Importación al vincular (N8)
-- ---------------------------------------------------------------------------
-- El servidor de Next.js valida el snapshot, cifra el PIN y arma un "plan" de
-- importación con columnas de la nube; estas funciones lo escriben en una sola
-- transacción, con la instalación bloqueada.

-- UUID nuevo para cada registro del plan cuyo id ya existe en esa tabla de la nube (en
-- cualquier instalación, vivo o borrado): {id_del_panel: id_nuevo}. Riesgo 4: nunca se
-- escribe sobre un registro existente por su id.
create function private.import_id_map(p_table text, p_rows jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_map jsonb;
begin
  execute format(
    'select coalesce(jsonb_object_agg(r.id, gen_random_uuid()), ''{}''::jsonb)
       from jsonb_to_recordset($1) as r (id uuid)
      where exists (select 1 from public.%I t where t.id = r.id)', p_table)
    into v_map
    using coalesce(p_rows, '[]'::jsonb);
  return v_map;
end;
$$;

-- El id con el que queda en la nube un registro (o una referencia) del plan.
create function private.import_id(p_map jsonb, p_id uuid)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select coalesce((p_map ->> p_id::text)::uuid, p_id);
$$;

-- Escribe un plan de importación en la instalación como cambios del panel:
-- updated_at = now(), updated_by = origin = p_author ('panel:<panel_code>').
-- Lo llaman import_panel_snapshot y confirm_panel_import con la instalación bloqueada.
-- p_plan trae listas por tabla, con columnas de la nube (el PIN ya cifrado):
--   holders: titulares nuevos; holder_pins: PIN para titulares vivos de la nube que no
--   tienen; cards, controls, control_buttons y holder_profiles: altas cuyas referencias
--   apuntan a un registro del mismo plan (por el id del panel) o a uno vivo de la
--   instalación; access_profiles: perfiles nuevos, con las máscaras, días y horario de
--   la regla de ESTE panel; outputs: las salidas del panel (se actualizan las vivas del
--   panel con el mismo output_index y las demás se dan de alta).
-- Los ids que ya existen en la nube reciben uno nuevo y las referencias del plan que
-- apuntan a ellos se reasignan (Riesgo 4). Para que eso no sea ambiguo, el servidor
-- nunca da de alta un titular, control o perfil con el id de uno vivo de la instalación
-- (ese sería el mismo registro, o recibe antes un UUID nuevo). Los triggers de N3 ponen
-- tenant_id y revision, y rechazan padres de otra instalación o borrados.
create function private.import_rows(p_inst uuid, p_panel_id uuid, p_author text, p_plan jsonb)
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

  insert into public.control_buttons (id, installation_id, control_id, button, rf_code, output_index,
                                      updated_at, updated_by, origin)
  select private.import_id(v_buttons, r.id), p_inst, private.import_id(v_controls, r.control_id), r.button,
         r.rf_code, r.output_index, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'control_buttons', '[]'::jsonb)) as r (
    id uuid, control_id uuid, button int, rf_code bigint, output_index int);

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

-- Importación directa (la llama POST /import-snapshot con la llave secreta). En una
-- sola transacción:
--   1. bloquea la instalación del panel y después el panel (mismo orden que el resto);
--   2. si el panel ya no está en staging, devuelve 'not_staging' sin escribir;
--   3. si la instalación tiene datos vivos (holders, cards, controls o access_profiles;
--      las salidas y reglas de otros paneles no cuentan), devuelve 'not_empty' sin
--      escribir: el servidor calcula el diff y llama stage_panel_import;
--   4. si está vacía, escribe el plan completo (import_rows), deja el panel en active,
--      borra su panel_imports y devuelve 'imported'.
-- Con la instalación bloqueada, dos paneles que se vinculan a la vez no importan los
-- dos como si la instalación estuviera vacía.
-- Va en public porque PostgREST no expone `private`; es security invoker y solo
-- service_role puede ejecutarla (igual que confirm_panel_import y stage_panel_import).
create function public.import_panel_snapshot(p_panel_id uuid, p_plan jsonb)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_inst uuid;
  v_locked uuid;
  v_status text;
  v_code text;
begin
  select p.installation_id into v_inst from public.panels p where p.id = p_panel_id;
  if v_inst is null then
    raise exception 'El panel no existe o no tiene instalación.' using errcode = '22023';
  end if;

  select i.id into v_locked from public.installations i where i.id = v_inst for no key update;
  select p.status, p.panel_code into v_status, v_code
  from public.panels p
  where p.id = p_panel_id and p.installation_id = v_inst
  for no key update;
  if v_status is distinct from 'staging' then
    return 'not_staging';
  end if;

  if exists (select 1 from public.holders t where t.installation_id = v_inst and t.deleted_at is null)
     or exists (select 1 from public.cards t where t.installation_id = v_inst and t.deleted_at is null)
     or exists (select 1 from public.controls t where t.installation_id = v_inst and t.deleted_at is null)
     or exists (select 1 from public.access_profiles t where t.installation_id = v_inst and t.deleted_at is null) then
    return 'not_empty';
  end if;

  perform private.import_rows(v_inst, p_panel_id, 'panel:' || v_code, p_plan);
  update public.panels p set status = 'active' where p.id = p_panel_id;
  delete from public.panel_imports pi where pi.panel_id = p_panel_id;
  return 'imported';
end;
$$;

-- Guarda el snapshot (con el PIN ya cifrado) y el diff de un panel en staging y lo pasa
-- a awaiting_review, en una transacción. Devuelve 'awaiting_review', o 'not_staging' sin
-- escribir si el panel ya no está en staging.
create function public.stage_panel_import(p_panel_id uuid, p_snapshot jsonb, p_diff jsonb)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_status text;
begin
  select p.status into v_status from public.panels p where p.id = p_panel_id for no key update;
  if v_status is distinct from 'staging' then
    return 'not_staging';
  end if;
  insert into public.panel_imports (panel_id, snapshot, diff)
  values (p_panel_id, p_snapshot, p_diff)
  on conflict (panel_id) do update
    set snapshot = excluded.snapshot, diff = excluded.diff, created_at = now();
  update public.panels p set status = 'awaiting_review' where p.id = p_panel_id;
  return 'awaiting_review';
end;
$$;

-- Importación revisada (la llama confirmImport con la llave secreta). En una sola
-- transacción:
--   1. bloquea la instalación y el panel;
--   2. si el panel ya no está en awaiting_review, devuelve 'not_awaiting' sin escribir;
--   3. si installations.revision no es p_expected_revision (la revisión con la que el
--      servidor leyó la nube para armar el plan), devuelve 'stale' sin escribir: el
--      servidor vuelve a leer y a armar el plan;
--   4. escribe el plan (import_rows), deja el panel en active, borra su panel_imports y
--      devuelve 'imported'.
create function public.confirm_panel_import(p_panel_id uuid, p_plan jsonb, p_expected_revision bigint)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_inst uuid;
  v_revision bigint;
  v_status text;
  v_code text;
begin
  select p.installation_id into v_inst from public.panels p where p.id = p_panel_id;
  if v_inst is null then
    raise exception 'El panel no existe o no tiene instalación.' using errcode = '22023';
  end if;

  select i.revision into v_revision from public.installations i where i.id = v_inst for no key update;
  select p.status, p.panel_code into v_status, v_code
  from public.panels p
  where p.id = p_panel_id and p.installation_id = v_inst
  for no key update;
  if v_status is distinct from 'awaiting_review' then
    return 'not_awaiting';
  end if;
  if v_revision is distinct from p_expected_revision then
    return 'stale';
  end if;

  perform private.import_rows(v_inst, p_panel_id, 'panel:' || v_code, p_plan);
  update public.panels p set status = 'active' where p.id = p_panel_id;
  delete from public.panel_imports pi where pi.panel_id = p_panel_id;
  return 'imported';
end;
$$;

revoke execute on function private.import_id_map(text, jsonb) from public;
revoke execute on function private.import_id(jsonb, uuid) from public;
revoke execute on function private.import_rows(uuid, uuid, text, jsonb) from public;
grant execute on function private.import_id_map(text, jsonb) to service_role;
grant execute on function private.import_id(jsonb, uuid) to service_role;
grant execute on function private.import_rows(uuid, uuid, text, jsonb) to service_role;

revoke execute on function public.import_panel_snapshot(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.stage_panel_import(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.confirm_panel_import(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.import_panel_snapshot(uuid, jsonb) to service_role;
grant execute on function public.stage_panel_import(uuid, jsonb, jsonb) to service_role;
grant execute on function public.confirm_panel_import(uuid, jsonb, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Grants: se retiran los defaults de Supabase (incluido TRUNCATE, que ignora RLS).
-- ---------------------------------------------------------------------------
revoke all on public.device_changes, public.sync_conflicts, public.panel_imports from public, anon, authenticated;
revoke all on sequence public.sync_conflicts_id_seq from public, anon, authenticated;

-- sync_conflicts: solo lectura para miembros (N15 agrega "Marcar como revisado").
-- device_changes y panel_imports: sin acceso para authenticated (la revisión de la
-- importación lee el diff desde el servidor, después de comprobar la membresía).
grant select on public.sync_conflicts to authenticated;

grant all on public.device_changes, public.sync_conflicts, public.panel_imports to service_role;
grant usage, select on sequence public.sync_conflicts_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.device_changes enable row level security;
alter table public.sync_conflicts enable row level security;
alter table public.panel_imports enable row level security;

-- device_changes y panel_imports: RLS activa y sin políticas (solo service_role/postgres).
create policy sync_conflicts_select on public.sync_conflicts for select to authenticated
  using ((select private.is_member(tenant_id)));

-- ---------------------------------------------------------------------------
-- Logs de acceso (N9)
-- ---------------------------------------------------------------------------
-- Copia en la nube del log local de cada panel. Idempotente por (panel_id, local_log_id):
-- los ids locales son por panel. holder_id y control_id no tienen FK: son copias
-- historicas, como en el panel (el titular puede borrarse y el log se conserva).
-- output_index guarda el `output_id` del contrato. Nunca se guardan digitos de PIN: un
-- log de PIN (source = 3) no lleva code.
create table public.access_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id uuid not null references public.installations (id) on delete cascade,
  panel_id uuid not null references public.panels (id) on delete cascade,
  local_log_id bigint not null,
  ts timestamptz not null,
  allowed boolean not null,
  source int not null,
  reason int not null,
  holder_id uuid,
  holder_name text,
  holder_kind text check (holder_kind in ('persona', 'domicilio')),
  credential_label text,
  control_id uuid,
  code bigint,
  device_id int,
  output_index int,
  unique (panel_id, local_log_id),
  check (source <> 3 or code is null)
);
create index access_logs_installation_id_ts_idx on public.access_logs (installation_id, ts desc);
create index access_logs_panel_id_ts_idx on public.access_logs (panel_id, ts desc);
-- Para RLS y para borrar un tenant (las FK en cascada buscan por tenant_id).
create index access_logs_tenant_id_idx on public.access_logs (tenant_id);

revoke all on public.access_logs from public, anon, authenticated;
revoke all on sequence public.access_logs_id_seq from public, anon, authenticated;
grant select on public.access_logs to authenticated;
grant all on public.access_logs to service_role;
grant usage, select on sequence public.access_logs_id_seq to service_role;

alter table public.access_logs enable row level security;
-- Solo lectura para los miembros; escribe el servidor (llave secreta) desde POST /logs.
create policy access_logs_select on public.access_logs for select to authenticated
  using ((select private.is_member(tenant_id)));

-- Retencion: el dia 1 de cada mes a las 03:00 (UTC) se borran los logs de mas de 12
-- meses. cron.schedule con un nombre ya existente lo reemplaza: la migracion es
-- idempotente y `supabase db reset` no duplica el trabajo.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'access-logs-retention',
  '0 3 1 * *',
  $cron$delete from public.access_logs where ts < now() - interval '12 months'$cron$
);
