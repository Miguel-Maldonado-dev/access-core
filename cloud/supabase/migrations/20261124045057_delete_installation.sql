-- Eliminación de una instalación (solo admin del tenant, desde el servidor con la llave secreta).
--
-- public.delete_installation(p_installation) borra físicamente, en una transacción, todos los
-- datos de la instalación en la nube y la fila de installations:
--   * filas replicadas (holders, cards con PIN, controls, control_buttons, control_button_panels,
--     access_profiles, holder_profiles, profile_panel_rules, outputs) y su audit_log;
--   * access_logs, panel_commands, sync_conflicts, log_purges y purged_rows (cascada de la FK);
--   * sus paneles (cualquier estado), con device_changes y panel_imports por cascada. El agente de
--     un panel eliminado recibe 401, borra su credencial, conserva su base local y vuelve a
--     registrarse como 'pending' (otro reclamo lo vincula a otra instalación).
-- Las filas de OTRAS instalaciones que aún nombran a uno de esos paneles (borrados lógicos de
-- cuando el panel se revocó allá) se eliminan igual que en private.purge_deleted_rows: con
-- lápida en purged_rows, sin audit_log ni conflictos y subiendo purged_revision de esa
-- instalación.
-- Ningún trigger de replicación, auditoría ni notify se dispara en DELETE.
-- Devuelve false si la instalación no existe.

create function public.delete_installation(p_installation uuid)
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
      or (a.table_name = 'outputs' and a.row_id in (select x.id from public.outputs x where x.installation_id = p_installation));

  -- Filas que nombran a los paneles sin cascada (FK 'no action'), luego los paneles
  -- (arrastran access_logs, panel_commands, sync_conflicts, device_changes y panel_imports).
  delete from public.control_button_panels l where l.installation_id = p_installation;
  delete from public.profile_panel_rules r where r.installation_id = p_installation;
  delete from public.outputs o where o.installation_id = p_installation;
  delete from public.panels p using tmp_inst_panels t where p.id = t.id;

  -- El resto cae por la cascada de installation_id.
  delete from public.installations i where i.id = p_installation;
  return true;
end;
$$;

revoke execute on function public.delete_installation(uuid) from public, anon, authenticated;
grant execute on function public.delete_installation(uuid) to service_role;
