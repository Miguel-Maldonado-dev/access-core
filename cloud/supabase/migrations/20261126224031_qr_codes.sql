-- qr_codes: datos de la nube para los códigos QR (accesos temporales).
--
-- * public.qr_codes: QR de los titulares (anfitriones), replicados como phones (revisión,
--   auditoría, borrado lógico en cascada desde holders, vaciado de la etiqueta al borrar, purga
--   con lápida). El código es único entre los QR vivos de la instalación (qr_codes_code_live_key)
--   y no puede repetir una tarjeta viva. Un QR no se edita: authenticated solo lo crea y lo
--   borra. Las fechas se guardan truncadas a segundos (viajan al panel como ISO con .000Z).
-- * Tope de QR vigentes (valid_until > now()) por instalación: trigger before insert con candado
--   pg_advisory_xact_lock (cubre API, web y push del panel; el push que excede queda como
--   conflicto). Un QR que ya llega vencido no se cuenta ni se limita.
-- * installations.qr_digit (1–9, 9), qr_max_active (1–100000, 1000) y qr_settings_revision: solo
--   los cambia public.set_installation_qr_settings (admin del tenant o servidor). Viajan al panel
--   como `qr_settings` (lo arma la capa TypeScript); el push de qr_settings nunca se aplica.
-- * cards_check_qr_range: una tarjeta viva no puede caer en el rango de QR de la instalación ni
--   repetir el código de un QR vivo (mismo candado por instalación que el tope).
-- * profile_panel_rules.qr_reader_mask: un panel v8 no lo envía; push_permission conserva el de
--   la nube (0 al crear) e import_rows usa 0.
-- * private.expire_qr_codes (trabajo diario qr-codes-expire, 10 minutos antes de
--   deleted-rows-purge): borra lógicamente los QR vencidos hace más de 30 días; la purga los
--   elimina 30 días después con lápida.
-- * Se redefinen completas desde su última versión en 20261125025657_phones_calls (solo cambia
--   lo de QR): scrub_deleted_row, sync_conflict_scrub, push_row_base, push_permission_base,
--   import_rows, unique_conflict_version, apply_panel_change, purge_deleted_rows y
--   delete_installation. Los check de audit_log, sync_conflicts y purged_rows incluyen qr_codes.
--
-- Orden de despliegue: primero la nube (`db push` y enseguida Vercel), después el paquete del
-- panel v9. Un panel v8 con la nube nueva ignora los QR (la nube no se los envía sin
-- `X-Acc-Schema: 9`). No se revierte la nube con paneles v9.

-- ---------------------------------------------------------------------------
-- Ajustes de QR de la instalación
-- ---------------------------------------------------------------------------
alter table public.installations
  add column qr_digit smallint not null default 9 check (qr_digit between 1 and 9),
  add column qr_max_active int not null default 1000 check (qr_max_active between 1 and 100000),
  add column qr_settings_revision bigint not null default 0;

-- Rango de códigos de QR para el dígito D (Wiegand 34: máximo 4294967295).
create function private.qr_range(p_digit int, out lo bigint, out hi bigint)
language sql
immutable
set search_path = ''
as $$
  select case when p_digit <= 4 then p_digit * 1000000000::bigint else p_digit * 100000000::bigint end,
         case when p_digit <= 3 then p_digit * 1000000000::bigint + 999999999
              when p_digit = 4 then 4294967295::bigint
              else p_digit * 100000000::bigint + 99999999 end;
$$;
revoke execute on function private.qr_range(int) from public, anon;
grant execute on function private.qr_range(int) to authenticated, service_role;

create function public.set_installation_qr_settings(p_installation uuid, p_digit int, p_max_active int)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inst public.installations;
  v_range record;
  v_rev bigint;
begin
  select * into v_inst from public.installations i where i.id = p_installation for update;
  if v_inst.id is null then
    raise exception 'instalación no encontrada' using errcode = 'P0002';
  end if;
  -- Desde la interfaz, solo el admin del tenant; el servidor (sin auth.uid()) siempre.
  if auth.uid() is not null and not private.is_tenant_admin(v_inst.tenant_id) then
    raise exception 'Solo el administrador cambia los ajustes de QR.' using errcode = '42501';
  end if;
  if p_digit is distinct from v_inst.qr_digit then
    select * into v_range from private.qr_range(p_digit);
    if exists (select 1 from public.cards c
                where c.installation_id = p_installation and c.deleted_at is null
                  and c.card_code between v_range.lo and v_range.hi) then
      raise exception 'Hay tarjetas en ese rango' using errcode = 'PT422';
    end if;
  end if;
  v_rev := private.bump_revision(p_installation);
  update public.installations i
     set qr_digit = p_digit, qr_max_active = p_max_active, qr_settings_revision = v_rev
   where i.id = p_installation;
end;
$$;
revoke execute on function public.set_installation_qr_settings(uuid, int, int) from public, anon;
grant execute on function public.set_installation_qr_settings(uuid, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- qr_codes
-- ---------------------------------------------------------------------------
create table public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  holder_id uuid not null,
  code bigint not null check (code between 0 and 4294967295),
  label text not null default '' check (char_length(label) <= 60),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  max_uses int not null default 1 check (max_uses between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint qr_codes_valid_range_check check (valid_until > valid_from),
  constraint qr_codes_holder_fkey foreign key (installation_id, holder_id)
    references public.holders (installation_id, id) on delete cascade
);

create unique index qr_codes_code_live_key on public.qr_codes (installation_id, code)
  where deleted_at is null;
create index qr_codes_installation_id_holder_id_idx on public.qr_codes (installation_id, holder_id);
create index qr_codes_installation_id_revision_idx on public.qr_codes (installation_id, revision);
create index qr_codes_tenant_id_idx on public.qr_codes (tenant_id);
create index qr_codes_deleted_at_idx on public.qr_codes (deleted_at) where deleted_at is not null;
-- Conteo de vigentes (tope) y vencimiento diario.
create index qr_codes_installation_id_valid_until_live_idx on public.qr_codes (installation_id, valid_until)
  where deleted_at is null;

-- Tope de vigentes, código igual a una tarjeta viva y fechas a segundos.
create function private.qr_codes_check_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max int;
begin
  new.valid_from := date_trunc('second', new.valid_from);
  new.valid_until := date_trunc('second', new.valid_until);
  new.created_at := date_trunc('second', new.created_at);
  if new.deleted_at is not null then
    return new;
  end if;
  -- Serializa las altas de la instalación para que el conteo no se rebase.
  perform pg_advisory_xact_lock(hashtextextended('qr_codes:' || new.installation_id::text, 0));
  if exists (select 1 from public.cards c
              where c.installation_id = new.installation_id and c.card_code = new.code
                and c.deleted_at is null) then
    raise exception 'El código ya es de una tarjeta.'
      using errcode = '23505', constraint = 'qr_codes_code_live_key';
  end if;
  if new.valid_until > now() then
    select i.qr_max_active into v_max from public.installations i where i.id = new.installation_id;
    if (select count(*) from public.qr_codes q
         where q.installation_id = new.installation_id and q.deleted_at is null
           and q.valid_until > now()) >= v_max then
      raise exception 'Se alcanzó el máximo de QR vigentes de la instalación.' using errcode = 'PT422';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.qr_codes_check_limits() from public;

create trigger qr_codes_before_insert_limits before insert on public.qr_codes
  for each row execute function private.qr_codes_check_limits();
create trigger qr_codes_before_write before insert or update on public.qr_codes
  for each row execute function private.replicated_before_write('holder_id', 'holders');
create trigger qr_codes_audit after insert or update on public.qr_codes
  for each row execute function private.replicated_audit();
create trigger qr_codes_scrub_deleted before insert or update on public.qr_codes
  for each row when (new.deleted_at is not null)
  execute function private.scrub_deleted_row();

alter table public.qr_codes enable row level security;
create policy qr_codes_select on public.qr_codes for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy qr_codes_insert on public.qr_codes for insert to authenticated
  with check ((select private.is_member(tenant_id)));
create policy qr_codes_update on public.qr_codes for update to authenticated
  using ((select private.is_member(tenant_id)))
  with check ((select private.is_member(tenant_id)));

revoke all on public.qr_codes from public, anon, authenticated;
grant all on public.qr_codes to service_role;
grant select on public.qr_codes to authenticated;
grant insert (installation_id, holder_id, code, label, valid_from, valid_until, max_uses)
  on public.qr_codes to authenticated;
-- Un QR no se edita: solo se revoca.
grant update (deleted_at) on public.qr_codes to authenticated;

-- Borrar un titular borra lógicamente sus tarjetas, controles, perfiles, teléfonos y QR.
drop trigger holders_soft_delete_cascade on public.holders;
create trigger holders_soft_delete_cascade after update of deleted_at on public.holders
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.replicated_soft_delete_cascade(
    'cards', 'holder_id', 'controls', 'holder_id', 'holder_profiles', 'holder_id', 'phones', 'holder_id',
    'qr_codes', 'holder_id');

-- ---------------------------------------------------------------------------
-- Tarjetas en el rango de QR
-- ---------------------------------------------------------------------------
create function private.cards_check_qr_range()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_range record;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  select r.lo, r.hi into v_range
  from public.installations i, private.qr_range(i.qr_digit) r
  where i.id = new.installation_id;
  -- Mismo candado que qr_codes_check_limits: una tarjeta y un QR simultáneos no chocan.
  perform pg_advisory_xact_lock(hashtextextended('qr_codes:' || new.installation_id::text, 0));
  -- Rango del dígito actual o código de un QR vivo (de cualquier dígito).
  if new.card_code between v_range.lo and v_range.hi
     or exists (select 1 from public.qr_codes q
                 where q.installation_id = new.installation_id and q.code = new.card_code
                   and q.deleted_at is null) then
    raise exception 'Ese código está reservado para QR.' using errcode = 'PT422';
  end if;
  return new;
end;
$$;
revoke execute on function private.cards_check_qr_range() from public;

create trigger cards_check_qr_range before insert or update of card_code on public.cards
  for each row execute function private.cards_check_qr_range();

-- ---------------------------------------------------------------------------
-- profile_panel_rules.qr_reader_mask
-- ---------------------------------------------------------------------------
alter table public.profile_panel_rules
  add column qr_reader_mask int not null default 0 check (qr_reader_mask between 0 and 15);
grant insert (qr_reader_mask) on public.profile_panel_rules to authenticated;
grant update (qr_reader_mask) on public.profile_panel_rules to authenticated;

-- ---------------------------------------------------------------------------
-- Tablas que se enumeran
-- ---------------------------------------------------------------------------
alter table public.audit_log drop constraint audit_log_table_name_check;
alter table public.audit_log add constraint audit_log_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'control_button_panels',
    'access_profiles', 'holder_profiles', 'profile_panel_rules', 'outputs', 'phones', 'panel_call_settings',
    'qr_codes'));

alter table public.sync_conflicts drop constraint sync_conflicts_table_name_check;
alter table public.sync_conflicts add constraint sync_conflicts_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'permissions',
    'holder_permissions', 'outputs', 'phones', 'call_settings', 'qr_codes'));

alter table public.purged_rows drop constraint purged_rows_table_name_check;
alter table public.purged_rows add constraint purged_rows_table_name_check
  check (table_name in ('holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
    'holder_profiles', 'profile_panel_rules', 'outputs', 'control_button_panels', 'phones',
    'panel_call_settings', 'qr_codes'));

-- ---------------------------------------------------------------------------
-- Funciones redefinidas (create or replace conserva sus grants)
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
    when 'qr_codes' then
      new.label := '';
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
      new.qr_reader_mask := 0;
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
    when 'qr_codes' then array['holder_id', 'code', 'label', 'valid_from', 'valid_until', 'max_uses', 'created_at']
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
           -- Un panel v8 no envía qr_reader_mask: se conserva el de la nube.
           qr_reader_mask = coalesce((p_data ->> 'qr_reader_mask')::int, r.qr_reader_mask),
           weekday_mask = (p_data ->> 'weekday_mask')::int,
           start_minute = (p_data ->> 'start_minute')::int,
           end_minute = (p_data ->> 'end_minute')::int,
           updated_at = p_ts, updated_by = p_author, origin = p_author
     where r.id = v_rule.id and r.installation_id = p_inst and r.panel_id = p_panel_id;
  else
    insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                            pin_reader_mask, allow_rf, allow_remote, allow_call, qr_reader_mask,
                                            weekday_mask, start_minute, end_minute, updated_at, updated_by, origin)
    values (p_inst, p_id, p_panel_id, (p_data ->> 'output_mask')::int, (p_data ->> 'card_reader_mask')::int,
            (p_data ->> 'pin_reader_mask')::int, (p_data ->> 'allow_rf')::boolean,
            coalesce((p_data ->> 'allow_remote')::boolean, false),
            coalesce((p_data ->> 'allow_call')::boolean, false),
            coalesce((p_data ->> 'qr_reader_mask')::int, 0),
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
  v_qr jsonb := private.import_id_map('qr_codes', p_plan -> 'qr_codes');
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
                                          pin_reader_mask, allow_rf, allow_remote, allow_call, qr_reader_mask,
                                          weekday_mask, start_minute, end_minute, updated_at, updated_by, origin)
  select p_inst, private.import_id(v_profiles, r.id), p_panel_id, r.output_mask, r.card_reader_mask,
         r.pin_reader_mask, r.allow_rf, coalesce(r.allow_remote, false), coalesce(r.allow_call, false), coalesce(r.qr_reader_mask, 0), r.weekday_mask, r.start_minute,
         r.end_minute, v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'access_profiles', '[]'::jsonb)) as r (
    id uuid, output_mask int, card_reader_mask int, pin_reader_mask int, allow_rf boolean, allow_remote boolean, allow_call boolean, qr_reader_mask int,
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

  -- QR del panel (un panel v8 no los envía).
  insert into public.qr_codes (id, installation_id, holder_id, code, label, valid_from, valid_until, max_uses,
                               created_at, updated_at, updated_by, origin)
  select private.import_id(v_qr, r.id), p_inst, private.import_id(v_holders, r.holder_id), r.code,
         coalesce(r.label, ''), r.valid_from, r.valid_until, coalesce(r.max_uses, 1), coalesce(r.created_at, v_now),
         v_now, p_author, p_author
  from jsonb_to_recordset(coalesce(p_plan -> 'qr_codes', '[]'::jsonb)) as r (
    id uuid, holder_id uuid, code bigint, label text, valid_from timestamptz, valid_until timestamptz,
    max_uses int, created_at timestamptz);

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
    when 'qr_codes_code_live_key' then
      coalesce(
        (select to_jsonb(q) from public.qr_codes q
          where q.installation_id = p_inst and q.code = (p_data ->> 'code')::bigint
            and q.deleted_at is null),
        (select to_jsonb(c) from public.cards c
          where c.installation_id = p_inst and c.card_code = (p_data ->> 'code')::bigint
            and c.deleted_at is null))
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
                     'holder_permissions', 'outputs', 'phones', 'call_settings', 'qr_codes', 'qr_settings')
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

  -- Los ajustes de QR los manda la nube: el push del panel nunca se aplica.
  if p_table = 'qr_settings' then
    v_result := jsonb_build_object('status', 'superseded');
    insert into public.device_changes (panel_id, change_id, result) values (p_panel_id, p_change_id, v_result);
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
    when sqlstate 'PT422' then
      -- Reglas de QR (tope de vigentes, código reservado): queda como conflicto.
      get stacked diagnostics v_constraint = message_text;
      v_out := jsonb_build_object('status', 'rejected', 'reason', v_constraint, 'conflict', jsonb_build_object(
        'kind', 'unique', 'cloud_version', null, 'resolution', 'Rechazado: ' || v_constraint));
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
    delete from public.qr_codes q
     where q.deleted_at < v_cutoff
        or q.holder_id in (select p.id from purged_parents p where p.table_name = 'holders')
    returning q.id, q.installation_id, q.revision)
  insert into tmp_purged select 'qr_codes', id, installation_id, revision from d;

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


-- delete_installation: también los QR.
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
      or (a.table_name = 'qr_codes' and a.row_id in (select x.id from public.qr_codes x where x.installation_id = p_installation))
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
-- Vencimiento: QR vencidos hace más de 30 días se borran lógicamente
-- ---------------------------------------------------------------------------
create function private.expire_qr_codes()
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.qr_codes q
     set deleted_at = now(), updated_at = now(), updated_by = 'system:qr', origin = 'cloud'
   where q.deleted_at is null
     and q.valid_until < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function private.expire_qr_codes() from public, anon, authenticated;
grant execute on function private.expire_qr_codes() to service_role;

-- Diario, 10 minutos antes de deleted-rows-purge. cron.schedule con un nombre ya existente lo
-- reemplaza: la migración es idempotente.
select cron.schedule('qr-codes-expire', '50 8 * * *', $cron$select private.expire_qr_codes()$cron$);
