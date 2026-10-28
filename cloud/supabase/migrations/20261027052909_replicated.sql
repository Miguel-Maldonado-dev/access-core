-- 0002_replicated: datos de acceso replicados con los paneles (N3).
-- Tablas: holders, cards, controls, control_buttons, access_profiles, holder_profiles,
-- profile_panel_rules, outputs (replicadas) y audit_log.
--
-- Columnas comunes de cada tabla replicada:
--   id, tenant_id (lo pone el trigger desde la instalación), installation_id,
--   updated_at, updated_by, origin ('cloud' | 'panel:<panel_code>'),
--   deleted_at (borrado lógico, solo en la nube) y revision (por instalación).
--
-- Quién escribe:
--   * la interfaz (authenticated, RLS por tenant): el trigger pone updated_at = now(),
--     updated_by = 'user:<uid>' y origin = 'cloud'; no puede escribir revision,
--     tenant_id, updated_by ni origin, ni borrar físicamente;
--   * el servidor (llave secreta, auth.uid() nulo): manda updated_at, updated_by y
--     origin explícitos y el trigger los respeta.
--
-- Las FK de profile_panel_rules.panel_id y outputs.panel_id hacia panels (y su índice)
-- las agrega N5.

-- ---------------------------------------------------------------------------
-- Tablas replicadas
-- ---------------------------------------------------------------------------
create table public.holders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  kind text not null check (kind in ('persona', 'domicilio')),
  name text not null check (length(trim(name)) > 0),
  department text not null default '',
  address text not null default '',
  notes text not null default '',
  pin_ciphertext text,
  pin_lookup text,
  has_pin boolean generated always as (pin_ciphertext is not null) stored,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint holders_pin_pair_check check ((pin_ciphertext is null) = (pin_lookup is null)),
  -- destino de las FK compuestas: los hijos solo apuntan a titulares de su instalación
  constraint holders_installation_id_id_key unique (installation_id, id)
);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  card_code bigint not null check (card_code between 0 and 4294967295),
  holder_id uuid not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint cards_holder_fkey foreign key (installation_id, holder_id)
    references public.holders (installation_id, id) on delete cascade
);

create table public.controls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  holder_id uuid not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint controls_installation_id_id_key unique (installation_id, id),
  constraint controls_holder_fkey foreign key (installation_id, holder_id)
    references public.holders (installation_id, id) on delete cascade
);

create table public.control_buttons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  control_id uuid not null,
  button int not null check (button between 0 and 3),
  rf_code bigint not null check (rf_code between 0 and 4294967295),
  output_index int check (output_index between 0 and 3),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint control_buttons_control_fkey foreign key (installation_id, control_id)
    references public.controls (installation_id, id) on delete cascade
);

create table public.access_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  name text not null,
  local_permission_id int not null check (local_permission_id between 0 and 31),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint access_profiles_installation_id_id_key unique (installation_id, id)
);

create table public.holder_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  holder_id uuid not null,
  profile_id uuid not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint holder_profiles_holder_fkey foreign key (installation_id, holder_id)
    references public.holders (installation_id, id) on delete cascade,
  constraint holder_profiles_profile_fkey foreign key (installation_id, profile_id)
    references public.access_profiles (installation_id, id) on delete cascade
);

create table public.profile_panel_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  profile_id uuid not null,
  panel_id uuid not null,
  output_mask int not null check (output_mask between 0 and 15),
  card_reader_mask int not null check (card_reader_mask between 0 and 15),
  pin_reader_mask int not null check (pin_reader_mask between 0 and 15),
  allow_rf boolean not null default false,
  weekday_mask int not null check (weekday_mask between 0 and 127),
  start_minute int not null check (start_minute between 0 and 1439),
  end_minute int not null check (end_minute between 0 and 1439),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null,
  constraint profile_panel_rules_profile_fkey foreign key (installation_id, profile_id)
    references public.access_profiles (installation_id, id) on delete cascade
);

create table public.outputs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  installation_id uuid not null references public.installations (id) on delete cascade,
  panel_id uuid not null,
  output_index int not null check (output_index between 0 and 3),
  alias text not null default '',
  duration_ms int not null check (duration_ms between 0 and 65535),
  reader_mask int not null check (reader_mask between 0 and 15),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  origin text not null check (origin = 'cloud' or origin like 'panel:_%'),
  deleted_at timestamptz,
  revision bigint not null
);

-- ---------------------------------------------------------------------------
-- Auditoría: quién, qué y cuándo. Sin columnas ni datos de PIN.
-- op: 'insert', 'update' o 'delete' (borrado lógico: deleted_at pasa de nulo a fecha).
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  table_name text not null check (table_name in ('holders', 'cards', 'controls', 'control_buttons',
    'access_profiles', 'holder_profiles', 'profile_panel_rules', 'outputs')),
  row_id uuid not null,
  op text not null check (op in ('insert', 'update', 'delete')),
  updated_by text not null,
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------
-- Unicidad sobre registros vivos (un borrado lógico libera el valor).
create unique index cards_card_code_live_key on public.cards (installation_id, card_code)
  where deleted_at is null;
create unique index control_buttons_rf_code_live_key on public.control_buttons (installation_id, rf_code)
  where deleted_at is null;
create unique index holders_pin_lookup_live_key on public.holders (installation_id, pin_lookup)
  where deleted_at is null;
create unique index access_profiles_local_permission_id_live_key
  on public.access_profiles (installation_id, local_permission_id) where deleted_at is null;
create unique index holder_profiles_holder_profile_live_key on public.holder_profiles (holder_id, profile_id)
  where deleted_at is null;
create unique index profile_panel_rules_profile_panel_live_key on public.profile_panel_rules (profile_id, panel_id)
  where deleted_at is null;
create unique index outputs_panel_output_live_key on public.outputs (panel_id, output_index)
  where deleted_at is null;
create unique index control_buttons_control_button_live_key on public.control_buttons (control_id, button)
  where deleted_at is null;

-- FK compuestas hacia el padre (también las usa la cascada lógica).
create index cards_installation_id_holder_id_idx on public.cards (installation_id, holder_id);
create index controls_installation_id_holder_id_idx on public.controls (installation_id, holder_id);
create index control_buttons_installation_id_control_id_idx on public.control_buttons (installation_id, control_id);
create index holder_profiles_installation_id_holder_id_idx on public.holder_profiles (installation_id, holder_id);
create index holder_profiles_installation_id_profile_id_idx on public.holder_profiles (installation_id, profile_id);
create index profile_panel_rules_installation_id_profile_id_idx
  on public.profile_panel_rules (installation_id, profile_id);

-- audit_log: FK y política por tenant, consultas por fecha.
create index audit_log_tenant_id_at_idx on public.audit_log (tenant_id, at);

-- Por tabla replicada: sincronización ("registros de la instalación con revision > N",
-- que también cubre la FK a installations) y la columna de la política (tenant_id).
do $$
declare
  t text;
begin
  foreach t in array array['holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                           'holder_profiles', 'profile_panel_rules', 'outputs'] loop
    execute format('create index %I on public.%I (installation_id, revision)',
                   t || '_installation_id_revision_idx', t);
    execute format('create index %I on public.%I (tenant_id)', t || '_tenant_id_idx', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revisión por instalación
-- ---------------------------------------------------------------------------
-- authenticated no puede escribir installations.revision (grant por columna de N2),
-- así que la función es security definer. EXECUTE solo para service_role: la interfaz
-- llega aquí únicamente a través de los triggers.
create function private.bump_revision(inst uuid)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  update public.installations
  set revision = revision + 1
  where id = inst
  returning revision;
$$;

-- BEFORE INSERT OR UPDATE de cada tabla replicada.
-- Argumentos del trigger: pares (columna, tabla padre) que deben existir vivos en la
-- misma instalación cuando la fila queda viva.
-- Es security definer porque lee la instalación sin RLS (para que un tenant_id ajeno
-- se rechace como ajeno) y porque bump_revision no es ejecutable por authenticated.
create function private.replicated_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row jsonb;
  v_alive boolean;
begin
  if tg_op = 'UPDATE'
     and (new.id is distinct from old.id or new.installation_id is distinct from old.installation_id) then
    raise exception 'No se puede cambiar el id ni la instalación de un registro.'
      using errcode = '23000';
  end if;

  select inst.tenant_id into v_tenant
  from public.installations inst
  where inst.id = new.installation_id;
  if not found then
    raise exception 'La instalación no existe.' using errcode = '23503';
  end if;
  -- Edición desde la interfaz: solo en instalaciones de un tenant del que es miembro.
  if v_uid is not null and not private.is_member(v_tenant) then
    raise exception 'Sin permiso sobre esta instalación.' using errcode = '42501';
  end if;

  new.tenant_id := v_tenant;
  -- Bloquea la fila de la instalación hasta el fin de la transacción: las escrituras
  -- de una instalación se serializan y las revisiones se confirman en orden.
  new.revision := private.bump_revision(new.installation_id);

  if v_uid is not null then
    new.updated_at := now();
    new.updated_by := 'user:' || v_uid;
    new.origin := 'cloud';
  end if;

  -- Una fila viva no puede apuntar a un padre borrado (el panel lo rechazaría por FK).
  -- Va después de bump_revision: con la instalación bloqueada, la consulta ya ve un
  -- borrado lógico concurrente del padre.
  if new.deleted_at is null and tg_nargs > 0 then
    v_row := to_jsonb(new);
    for i in 0 .. tg_nargs - 1 by 2 loop
      execute format(
        'select exists (select 1 from public.%I where id = $1 and installation_id = $2 and deleted_at is null)',
        tg_argv[i + 1])
      into v_alive
      using (v_row ->> tg_argv[i])::uuid, new.installation_id;
      if not v_alive then
        raise exception 'El registro relacionado (%) no existe o está borrado.', tg_argv[i]
          using errcode = '23503';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

-- AFTER UPDATE OF deleted_at: borrado lógico en cascada, en la misma transacción.
-- Argumentos: pares (tabla hija, columna que apunta al padre).
-- Cada hijo pasa por su propio BEFORE trigger (revisión propia). Se le copian
-- deleted_at, updated_at, updated_by y origin del padre: si escribe el servidor
-- (auth.uid() nulo) el BEFORE trigger los respeta; si escribe un usuario, el BEFORE
-- trigger pone los mismos valores que puso en el padre (now() es el de la transacción).
-- Es security definer porque authenticated no puede escribir updated_by ni origin.
create function private.replicated_soft_delete_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  for i in 0 .. tg_nargs - 1 by 2 loop
    execute format(
      'update public.%I
          set deleted_at = $1, updated_at = $2, updated_by = $3, origin = $4
        where installation_id = $5 and %I = $6 and deleted_at is null',
      tg_argv[i], tg_argv[i + 1])
    using new.deleted_at, new.updated_at, new.updated_by, new.origin, new.installation_id, new.id;
  end loop;
  return null;
end;
$$;

-- AFTER INSERT OR UPDATE: una fila de auditoría por cambio (sin PIN).
create function private.replicated_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (tenant_id, table_name, row_id, op, updated_by)
  values (
    new.tenant_id,
    tg_table_name,
    new.id,
    case
      when tg_op = 'INSERT' then 'insert'
      when old.deleted_at is null and new.deleted_at is not null then 'delete'
      else 'update'
    end,
    new.updated_by);
  return null;
end;
$$;

revoke execute on function private.bump_revision(uuid) from public;
revoke execute on function private.replicated_before_write() from public;
revoke execute on function private.replicated_soft_delete_cascade() from public;
revoke execute on function private.replicated_audit() from public;
grant execute on function private.bump_revision(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger holders_before_write before insert or update on public.holders
  for each row execute function private.replicated_before_write();
create trigger cards_before_write before insert or update on public.cards
  for each row execute function private.replicated_before_write('holder_id', 'holders');
create trigger controls_before_write before insert or update on public.controls
  for each row execute function private.replicated_before_write('holder_id', 'holders');
create trigger control_buttons_before_write before insert or update on public.control_buttons
  for each row execute function private.replicated_before_write('control_id', 'controls');
create trigger access_profiles_before_write before insert or update on public.access_profiles
  for each row execute function private.replicated_before_write();
create trigger holder_profiles_before_write before insert or update on public.holder_profiles
  for each row execute function private.replicated_before_write('holder_id', 'holders', 'profile_id', 'access_profiles');
create trigger profile_panel_rules_before_write before insert or update on public.profile_panel_rules
  for each row execute function private.replicated_before_write('profile_id', 'access_profiles');
create trigger outputs_before_write before insert or update on public.outputs
  for each row execute function private.replicated_before_write();

create trigger holders_soft_delete_cascade after update of deleted_at on public.holders
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.replicated_soft_delete_cascade(
    'cards', 'holder_id', 'controls', 'holder_id', 'holder_profiles', 'holder_id');
create trigger controls_soft_delete_cascade after update of deleted_at on public.controls
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.replicated_soft_delete_cascade('control_buttons', 'control_id');
create trigger access_profiles_soft_delete_cascade after update of deleted_at on public.access_profiles
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.replicated_soft_delete_cascade(
    'holder_profiles', 'profile_id', 'profile_panel_rules', 'profile_id');

-- Auditoría, RLS y grants comunes a las 8 tablas replicadas.
-- RLS: miembros del tenant (TO authenticated); UPDATE con USING y WITH CHECK; sin DELETE.
-- Grants: el default de Supabase local da a anon/authenticated TRUNCATE, REFERENCES,
-- TRIGGER y MAINTAIN en tablas nuevas de public; se retiran. service_role: todo.
do $$
declare
  t text;
begin
  foreach t in array array['holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                           'holder_profiles', 'profile_panel_rules', 'outputs'] loop
    execute format('create trigger %I after insert or update on public.%I
                      for each row execute function private.replicated_audit()', t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated
                      using ((select private.is_member(tenant_id)))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated
                      with check ((select private.is_member(tenant_id)))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated
                      using ((select private.is_member(tenant_id)))
                      with check ((select private.is_member(tenant_id)))', t || '_update', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants de authenticated por columna.
-- Nunca: id, tenant_id, revision, updated_at, updated_by, origin (los pone el trigger).
-- installation_id solo al insertar (una fila no cambia de instalación); tampoco se
-- actualizan las columnas que atan una fila a su panel, perfil o padre de relación.
-- ---------------------------------------------------------------------------
-- holders: el PIN cifrado y su pin_lookup se escriben (los calcula el servidor de
-- Next.js) pero nunca se leen; las listas usan has_pin.
grant select (id, tenant_id, installation_id, kind, name, department, address, notes, has_pin,
              updated_at, updated_by, origin, deleted_at, revision)
  on public.holders to authenticated;
grant insert (installation_id, kind, name, department, address, notes, pin_ciphertext, pin_lookup)
  on public.holders to authenticated;
grant update (kind, name, department, address, notes, pin_ciphertext, pin_lookup, deleted_at)
  on public.holders to authenticated;

grant select on public.cards to authenticated;
grant insert (installation_id, card_code, holder_id, description) on public.cards to authenticated;
grant update (card_code, holder_id, description, deleted_at) on public.cards to authenticated;

grant select on public.controls to authenticated;
grant insert (installation_id, holder_id, description) on public.controls to authenticated;
grant update (holder_id, description, deleted_at) on public.controls to authenticated;

grant select on public.control_buttons to authenticated;
grant insert (installation_id, control_id, button, rf_code, output_index) on public.control_buttons to authenticated;
grant update (button, rf_code, output_index, deleted_at) on public.control_buttons to authenticated;

-- local_permission_id se asigna al crear el perfil y no cambia (es el permission_id local).
grant select on public.access_profiles to authenticated;
grant insert (installation_id, name, local_permission_id) on public.access_profiles to authenticated;
grant update (name, deleted_at) on public.access_profiles to authenticated;

grant select on public.holder_profiles to authenticated;
grant insert (installation_id, holder_id, profile_id) on public.holder_profiles to authenticated;
grant update (deleted_at) on public.holder_profiles to authenticated;

grant select on public.profile_panel_rules to authenticated;
grant insert (installation_id, profile_id, panel_id, output_mask, card_reader_mask, pin_reader_mask,
              allow_rf, weekday_mask, start_minute, end_minute)
  on public.profile_panel_rules to authenticated;
grant update (output_mask, card_reader_mask, pin_reader_mask, allow_rf, weekday_mask, start_minute,
              end_minute, deleted_at)
  on public.profile_panel_rules to authenticated;

-- outputs: las 4 salidas de cada panel no se borran desde la interfaz (sin deleted_at).
grant select on public.outputs to authenticated;
grant insert (installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled)
  on public.outputs to authenticated;
grant update (alias, duration_ms, reader_mask, enabled) on public.outputs to authenticated;

-- ---------------------------------------------------------------------------
-- audit_log: lectura para miembros; la escriben solo los triggers.
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;
create policy audit_log_select on public.audit_log for select to authenticated
  using ((select private.is_member(tenant_id)));

revoke all on public.audit_log from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;
grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;
