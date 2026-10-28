-- tenant_admin_guard: cada tenant conserva al menos un administrador (N11), y búsquedas
-- en auth.users para invitar miembros y mostrar sus correos (solo con la llave secreta).

-- ---------------------------------------------------------------------------
-- Al menos un administrador por tenant
-- ---------------------------------------------------------------------------
-- Trigger AFTER ROW en tenant_members (DELETE y UPDATE de role o tenant_id): cuando un
-- admin deja de serlo en su tenant, el tenant debe conservar otro admin. Al ser AFTER, la
-- comprobación ve el efecto completo de la sentencia (quitar a todos los admins de una vez
-- también falla).
--  - Bloquea la fila del tenant (FOR NO KEY UPDATE) antes de contar, para que dos
--    transacciones que quitan o degradan a los dos últimos admins a la vez no pasen las
--    dos: la segunda espera a la primera y, en READ COMMITTED, cuenta ya con su cambio.
--    FOR NO KEY UPDATE no choca con el FOR KEY SHARE de las FK (altas de miembros).
--  - Si el tenant ya no existe (borrado en cascada desde public.tenants), lo permite.
--  - Es security definer para poder bloquear el tenant aunque la RLS de quien escribe no
--    le deje actualizarlo (un admin del tenant no es súper administrador).
-- El borrado en Auth del último admin de un tenant vivo también falla: antes hay que
-- nombrar a otro admin o borrar el tenant.
create function private.tenant_members_keep_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'admin'
     or (tg_op = 'UPDATE' and new.role = 'admin' and new.tenant_id = old.tenant_id) then
    return null;
  end if;

  perform 1 from public.tenants t where t.id = old.tenant_id for no key update;
  if not found then
    return null;
  end if;

  if not exists (
    select 1 from public.tenant_members m
    where m.tenant_id = old.tenant_id and m.role = 'admin'
  ) then
    raise exception 'El tenant debe tener al menos un administrador.' using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke execute on function private.tenant_members_keep_admin() from public;

create trigger tenant_members_keep_admin
  after delete or update of role, tenant_id on public.tenant_members
  for each row execute function private.tenant_members_keep_admin();

-- ---------------------------------------------------------------------------
-- Búsquedas en auth.users (solo service_role)
-- ---------------------------------------------------------------------------
-- Van en public porque PostgREST no expone `private`; EXECUTE solo para service_role.
-- Son security definer porque service_role no lee auth.users.

-- Id del usuario de Auth con ese correo (sin distinguir mayúsculas ni espacios), o null.
-- Permite agregar como miembro a quien ya tiene cuenta sin volver a invitarlo.
create function public.auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from auth.users u
  where u.email = lower(trim(p_email))
  order by u.created_at
  limit 1;
$$;

-- Correo y si ya confirmó su cuenta (aceptó la invitación) de los usuarios pedidos.
create function public.auth_user_emails(p_user_ids uuid[])
returns table (user_id uuid, email text, email_confirmed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email::text, u.email_confirmed_at is not null
  from auth.users u
  where u.id = any (p_user_ids);
$$;

revoke execute on function public.auth_user_id_by_email(text) from public, anon, authenticated;
revoke execute on function public.auth_user_emails(uuid[]) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
grant execute on function public.auth_user_emails(uuid[]) to service_role;
