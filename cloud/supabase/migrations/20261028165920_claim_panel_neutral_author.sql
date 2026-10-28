-- claim_panel firma con un autor neutro lo que borra en la instalación anterior.
--
-- Antes recibía p_updated_by ('user:<uid>' de quien reclama) y lo escribía en las outputs y
-- profile_panel_rules que el panel dejó en OTRA instalación, que puede ser de otro tenant:
-- los miembros de ese tenant veían el uid de un usuario ajeno en esas filas y en audit_log.
-- Ahora esos borrados se firman siempre como 'system:reclamo' y la función ya no recibe el
-- autor. Se reemplaza la firma de 4 argumentos por una de 3 (la llaman claimPanelAs y el E2E).
--
-- Comportamiento (igual que antes, salvo el autor):
--   1. reclama el panel (pending → claimed) en la instalación indicada, solo si sigue pendiente
--      con el mismo claim_code_hash que el servidor verificó (reclamos simultáneos);
--   2. borra lógicamente las outputs y profile_panel_rules VIVAS de ese panel que son de otra
--      instalación. Si vuelve a la misma instalación no se toca nada. Escribe como servidor:
--      updated_at = now(), updated_by = 'system:reclamo' y origin = 'cloud'.
-- Devuelve {id, panel_code, status, installation_id}, o null si el panel ya no estaba pendiente
-- con ese código. Es security invoker y solo service_role (que salta RLS) puede ejecutarla.

drop function public.claim_panel(uuid, text, uuid, text);

create function public.claim_panel(
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

  return v_panel;
end;
$$;

revoke execute on function public.claim_panel(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_panel(uuid, text, uuid) to service_role;
