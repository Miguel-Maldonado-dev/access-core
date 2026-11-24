-- Revocar un panel borra de la nube lo que pertenece solo a ese panel.
--
-- * private.cleanup_revoked_panel(p_panel): borrado lógico (deleted_at, firmado como
--   'system:revocacion', origin 'cloud'; revision la pone replicated_before_write) de las
--   salidas, los vínculos de botones (control_button_panels) y las reglas de perfil
--   (profile_panel_rules) vivos del panel, y marca 'expired' sus órdenes pendientes.
--   No toca access_logs, titulares, tarjetas, controles ni control_buttons: los logs se
--   conservan hasta la retención de 30 días o "Borrar logs".
-- * public.revoke_panel(p_panel): revoca (status 'revoked', sin token) y limpia en la misma
--   transacción. Es idempotente: revocar de nuevo un panel ya revocado completa la limpieza.
--   Solo la ejecuta service_role (llave secreta).
-- * Los paneles que ya estaban revocados se limpian al aplicar la migración.

create function private.cleanup_revoked_panel(p_panel uuid)
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
  update public.panel_commands c
     set status = 'expired', finished_at = now()
   where c.panel_id = p_panel
     and c.status = 'pending';
end;
$$;

revoke execute on function private.cleanup_revoked_panel(uuid) from public, anon, authenticated;
grant execute on function private.cleanup_revoked_panel(uuid) to service_role;

create function public.revoke_panel(p_panel uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  update public.panels p
     set status = 'revoked', device_token_hash = null
   where p.id = p_panel;
  if not found then
    return false;
  end if;
  perform private.cleanup_revoked_panel(p_panel);
  return true;
end;
$$;

revoke execute on function public.revoke_panel(uuid) from public, anon, authenticated;
grant execute on function public.revoke_panel(uuid) to service_role;

-- Paneles ya revocados antes de esta migración.
select private.cleanup_revoked_panel(p.id) from public.panels p where p.status = 'revoked';
