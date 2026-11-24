-- Limpieza de filas huérfanas de paneles.
--
-- Bug: un panel revocado que se volvía a registrar (revoked -> pending, installation_id = null)
-- conservaba sus salidas, reglas y vínculos vivos en la instalación anterior, y la API los
-- seguía devolviendo. revoke_panel solo limpió los paneles que estaban 'revoked' al aplicarse.
--
-- * private.cleanup_orphan_panel_rows(p_panel): borrado lógico (firmado 'system:revocacion',
--   origin 'cloud') de las salidas, reglas de perfil y vínculos de botones vivos cuya fila de
--   panels tenga otra installation_id (o ninguna: pending), y expira las órdenes pendientes de
--   esos paneles. Sin argumento revisa todos los paneles. No toca los paneles de la misma
--   instalación de la fila (claimed, staging, awaiting_review, active).
-- * public.reregister_revoked_panel(...): revoked -> pending en una transacción: primero limpia
--   (mientras el panel aún tiene su instalación) y luego quita la instalación y el estado de
--   sincronización. Solo la ejecuta service_role. Devuelve false si el panel ya no está revoked.
-- * Al aplicarse limpia lo que ya quedó huérfano en producción.

create function private.cleanup_orphan_panel_rows(p_panel uuid default null)
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
  update public.panel_commands c
     set status = 'expired', finished_at = now()
    from public.panels p
   where p.id = c.panel_id
     and (p_panel is null or p.id = p_panel)
     and c.status = 'pending'
     and p.installation_id is distinct from c.installation_id;
end;
$$;

revoke execute on function private.cleanup_orphan_panel_rows(uuid) from public, anon, authenticated;
grant execute on function private.cleanup_orphan_panel_rows(uuid) to service_role;

create function public.reregister_revoked_panel(
  p_panel uuid,
  p_claim_code_hash text,
  p_software_version text,
  p_schema_version int
)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform 1 from public.panels p where p.id = p_panel and p.status = 'revoked' for update;
  if not found then
    return false;
  end if;
  -- Antes de quitar la instalación: lo que el panel dejó vivo allá se borra.
  perform private.cleanup_revoked_panel(p_panel);
  update public.panels p
     set status = 'pending',
         installation_id = null,
         claim_code_hash = p_claim_code_hash,
         device_token_hash = null,
         online = false,
         synced_revision = 0,
         last_sync_at = null,
         sync_blocked = null,
         confirm_deletions_until = null,
         software_version = p_software_version,
         schema_version = p_schema_version
   where p.id = p_panel;
  return true;
end;
$$;

revoke execute on function public.reregister_revoked_panel(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.reregister_revoked_panel(uuid, text, text, int) to service_role;

-- Huérfanos ya existentes (paneles que se volvieron a registrar o se reclamaron en otra instalación).
select private.cleanup_orphan_panel_rows();
