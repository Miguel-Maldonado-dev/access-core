-- 0003_panels: paneles, vinculación y límite de intentos de reclamo (N5).
-- Tablas: panels y panel_claim_attempts. Agrega las FK de outputs.panel_id y
-- profile_panel_rules.panel_id hacia panels y la función public.claim_panel.
--
-- Quién escribe: solo el servidor (llave secreta). authenticated lee de panels las
-- columnas no secretas de los paneles de su tenant; nunca los hashes.
--
-- Ciclo de vida (status):
--   pending ─claimPanel→ claimed ─/activate→ staging → awaiting_review | active
--   claimed | staging | awaiting_review | active ─revokePanel→ revoked ─/register→ pending
-- installation_id se asigna al reclamar, se conserva al revocar y se borra cuando el
-- panel revocado se vuelve a registrar; tenant_id lo pone el trigger desde la instalación.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table public.panels (
  id uuid primary key default gen_random_uuid(),
  panel_code text not null unique
    check (panel_code ~ '^PNL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  -- sha256 en hexadecimal; nunca se guarda el valor en claro.
  claim_code_hash text check (claim_code_hash ~ '^[0-9a-f]{64}$'),
  panel_secret_hash text not null check (panel_secret_hash ~ '^[0-9a-f]{64}$'),
  device_token_hash text check (device_token_hash ~ '^[0-9a-f]{64}$'),
  installation_id uuid references public.installations (id),
  tenant_id uuid references public.tenants (id),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'staging', 'awaiting_review', 'active', 'revoked')),
  online boolean not null default false,
  last_seen_at timestamptz,
  software_version text,
  schema_version int,
  synced_revision bigint not null default 0,
  last_sync_at timestamptz,
  sync_blocked jsonb,
  confirm_deletions_until timestamptz,
  created_at timestamptz not null default now(),
  -- Solo un panel pendiente está sin instalación (un revocado conserva la suya).
  constraint panels_installation_status_check check ((status = 'pending') = (installation_id is null)),
  -- La credencial de dispositivo existe solo desde la activación y hasta la revocación.
  constraint panels_device_token_status_check
    check (device_token_hash is null or status in ('staging', 'awaiting_review', 'active')),
  -- El código de vinculación es de un solo uso: se borra al reclamar.
  constraint panels_claim_code_status_check check (claim_code_hash is null or status = 'pending')
);

-- Intentos fallidos de claimPanel, para el límite por tenant (10 por hora).
create table public.panel_claim_attempts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------
-- panel_code ya tiene índice por su UNIQUE.
create index panels_installation_id_idx on public.panels (installation_id);
create index panels_tenant_id_idx on public.panels (tenant_id);
create index panel_claim_attempts_tenant_id_at_idx on public.panel_claim_attempts (tenant_id, at);

-- ---------------------------------------------------------------------------
-- tenant_id del panel = tenant de su instalación (nulo sin instalación)
-- ---------------------------------------------------------------------------
create function private.panels_set_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.installation_id is null then
    new.tenant_id := null;
  else
    select inst.tenant_id into new.tenant_id
    from public.installations inst
    where inst.id = new.installation_id;
  end if;
  return new;
end;
$$;

revoke execute on function private.panels_set_tenant() from public;

create trigger panels_set_tenant before insert or update of installation_id, tenant_id on public.panels
  for each row execute function private.panels_set_tenant();

-- ---------------------------------------------------------------------------
-- outputs y profile_panel_rules: FK hacia panels y misma instalación
-- ---------------------------------------------------------------------------
alter table public.outputs
  add constraint outputs_panel_id_fkey foreign key (panel_id) references public.panels (id);
alter table public.profile_panel_rules
  add constraint profile_panel_rules_panel_id_fkey foreign key (panel_id) references public.panels (id);

-- Índices no parciales para las FK (los únicos parciales de N3 no sirven a la FK).
create index outputs_panel_id_idx on public.outputs (panel_id);
create index profile_panel_rules_panel_id_idx on public.profile_panel_rules (panel_id);

-- Al dar de alta (o mover) una salida o una regla, su panel debe estar en la misma
-- instalación. No es una FK compuesta porque panels.installation_id cambia cuando un
-- panel se revoca y se reclama en otra instalación: las filas viejas siguen siendo
-- válidas y actualizables (p. ej. su borrado lógico).
-- Security invoker: authenticated lee panels con su RLS; un panel ajeno no es visible
-- y se rechaza igual que uno inexistente.
create function private.check_panel_installation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.panel_id is not distinct from old.panel_id
     and new.installation_id is not distinct from old.installation_id then
    return new;
  end if;
  if not exists (
    select 1 from public.panels p
    where p.id = new.panel_id and p.installation_id = new.installation_id
  ) then
    raise exception 'El panel no pertenece a esta instalación.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function private.check_panel_installation() from public;

create trigger outputs_panel_installation before insert or update of panel_id, installation_id
  on public.outputs
  for each row execute function private.check_panel_installation();
create trigger profile_panel_rules_panel_installation before insert or update of panel_id, installation_id
  on public.profile_panel_rules
  for each row execute function private.check_panel_installation();

-- ---------------------------------------------------------------------------
-- Reclamo atómico de un panel (lo llama claimPanel con la llave secreta)
-- ---------------------------------------------------------------------------
-- En una sola transacción:
--   1. pasa el panel de pending a claimed en p_installation_id, solo si sigue pendiente
--      con el mismo claim_code_hash que el servidor verificó (reclamos simultáneos);
--   2. borra lógicamente las outputs y profile_panel_rules VIVAS de ese panel que son de
--      otra instalación (la anterior: el panel revocado perdió su installation_id al
--      registrarse de nuevo, pero sus filas viejas la conservan). Si vuelve a la misma
--      instalación no se toca nada. Escribe como servidor: updated_at = now(),
--      updated_by = p_updated_by ('user:<uid>') y origin = 'cloud' (contrato de N3).
-- Devuelve {id, panel_code, status, installation_id}, o null si el panel ya no estaba
-- pendiente con ese código.
-- Va en public porque PostgREST no expone `private`; es security invoker y solo
-- service_role (que salta RLS) puede ejecutarla.
create function public.claim_panel(
  p_panel_id uuid,
  p_claim_code_hash text,
  p_installation_id uuid,
  p_updated_by text
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
     set deleted_at = now(), updated_at = now(), updated_by = p_updated_by, origin = 'cloud'
   where o.panel_id = p_panel_id
     and o.installation_id <> p_installation_id
     and o.deleted_at is null;
  update public.profile_panel_rules r
     set deleted_at = now(), updated_at = now(), updated_by = p_updated_by, origin = 'cloud'
   where r.panel_id = p_panel_id
     and r.installation_id <> p_installation_id
     and r.deleted_at is null;

  return v_panel;
end;
$$;

revoke execute on function public.claim_panel(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_panel(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Grants: se retiran los defaults de Supabase (incluido TRUNCATE, que ignora RLS).
-- ---------------------------------------------------------------------------
revoke all on public.panels, public.panel_claim_attempts from public, anon, authenticated;
revoke all on sequence public.panel_claim_attempts_id_seq from public, anon, authenticated;

-- panels: lectura por columna, sin los hashes; sin escritura para authenticated.
grant select (id, panel_code, installation_id, tenant_id, status, online, last_seen_at,
              software_version, schema_version, synced_revision, last_sync_at, sync_blocked,
              confirm_deletions_until, created_at)
  on public.panels to authenticated;
-- panel_claim_attempts: sin acceso para authenticated.

grant all on public.panels, public.panel_claim_attempts to service_role;
grant usage, select on sequence public.panel_claim_attempts_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.panels enable row level security;
alter table public.panel_claim_attempts enable row level security;

-- panels: los miembros leen los paneles de su tenant (un pendiente no tiene tenant).
create policy panels_select on public.panels for select to authenticated
  using ((select private.is_member(tenant_id)));

-- panel_claim_attempts: RLS activa y sin políticas (solo service_role/postgres).
