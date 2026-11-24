-- Pruebas de private.cleanup_orphan_panel_rows y public.reregister_revoked_panel.
begin;
select plan(13);

select ok(not has_function_privilege('authenticated', 'public.reregister_revoked_panel(uuid, text, text, int)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.reregister_revoked_panel(uuid, text, text, int)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.reregister_revoked_panel(uuid, text, text, int)', 'EXECUTE'),
  'solo service_role ejecuta reregister_revoked_panel');
select ok(not has_function_privilege('authenticated', 'private.cleanup_orphan_panel_rows(uuid)', 'EXECUTE'),
  'authenticated no ejecuta cleanup_orphan_panel_rows');

insert into public.tenants (id, name) values ('12000000-0000-0000-0000-00000000000a', 'Tenant O');
insert into public.installations (id, tenant_id, name) values
  ('22000000-0000-0000-0000-00000000000a', '12000000-0000-0000-0000-00000000000a', 'Fracc O1'),
  ('22000000-0000-0000-0000-00000000000b', '12000000-0000-0000-0000-00000000000a', 'Fracc O2');
-- Las filas nacen mientras los paneles pertenecen a O1 (un trigger lo exige); después P y R cambian de instalación.
-- Q (b): activo en O1. S (d): revocado en O1.
insert into public.panels (id, panel_code, panel_secret_hash, installation_id, status) values
  ('c2000000-0000-0000-0000-00000000000a', 'PNL-QQQQ-000A', repeat('2', 64), '22000000-0000-0000-0000-00000000000a', 'active'),
  ('c2000000-0000-0000-0000-00000000000b', 'PNL-QQQQ-000B', repeat('4', 64), '22000000-0000-0000-0000-00000000000a', 'active'),
  ('c2000000-0000-0000-0000-00000000000c', 'PNL-QQQQ-000C', repeat('6', 64), '22000000-0000-0000-0000-00000000000a', 'active'),
  ('c2000000-0000-0000-0000-00000000000d', 'PNL-QQQQ-000D', repeat('8', 64), '22000000-0000-0000-0000-00000000000a', 'revoked');

insert into public.outputs (installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled,
                            updated_by, origin)
select '22000000-0000-0000-0000-00000000000a', p, i, 'Salida', 3000, 1, true, 'prueba', 'cloud'
from unnest(array['c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000b',
                  'c2000000-0000-0000-0000-00000000000c', 'c2000000-0000-0000-0000-00000000000d']::uuid[]) p,
     generate_series(0, 3) i;

insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_by, origin) values
  ('42000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', 'Perfil', 1, 'prueba', 'cloud');
insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                        pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute,
                                        updated_by, origin)
select '22000000-0000-0000-0000-00000000000a', '42000000-0000-0000-0000-00000000000a', p, 15, 15, 0, true, 127, 0, 0,
       'prueba', 'cloud'
from unnest(array['c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000b',
                  'c2000000-0000-0000-0000-00000000000c', 'c2000000-0000-0000-0000-00000000000d']::uuid[]) p;

insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('32000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'prueba', 'cloud');
insert into public.controls (id, installation_id, holder_id, updated_by, origin) values
  ('52000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   '32000000-0000-0000-0000-00000000000a', 'prueba', 'cloud');
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_by, origin) values
  ('62000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   '52000000-0000-0000-0000-00000000000a', 0, 4321, 'prueba', 'cloud');
insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
select '22000000-0000-0000-0000-00000000000a', '62000000-0000-0000-0000-00000000000a', p, 0, 'prueba', 'cloud'
from unnest(array['c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000b',
                  'c2000000-0000-0000-0000-00000000000c']::uuid[]) p;

insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
select '12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', p, 'test_output', 0, 'x',
       now() + interval '10 seconds'
from unnest(array['c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000b']::uuid[]) p;

-- El estado que dejaba el bug: P volvió a pending sin instalación; R se reclamó en otra instalación.
update public.panels set status = 'pending', installation_id = null, device_token_hash = null
 where id = 'c2000000-0000-0000-0000-00000000000a';
update public.panels set status = 'claimed', installation_id = '22000000-0000-0000-0000-00000000000b'
 where id = 'c2000000-0000-0000-0000-00000000000c';

select private.cleanup_orphan_panel_rows();

select is((select count(*)::int from public.outputs
           where panel_id = 'c2000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'panel pending: sus salidas quedan borradas');
select is((select count(*)::int from public.outputs
           where panel_id in ('c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000c')
             and updated_by = 'system:revocacion' and origin = 'cloud'), 8,
  'firmadas como system:revocacion (pending y reclamado en otra instalación)');
select is((select count(*)::int from public.profile_panel_rules
           where panel_id in ('c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000c')
             and deleted_at is null), 0,
  'sus reglas quedan borradas');
select is((select count(*)::int from public.control_button_panels
           where panel_id in ('c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000c')
             and deleted_at is null), 0,
  'sus vínculos quedan borrados');
select results_eq(
  $$select (select count(*)::int from public.outputs
            where panel_id = 'c2000000-0000-0000-0000-00000000000b' and deleted_at is null),
           (select count(*)::int from public.profile_panel_rules
            where panel_id = 'c2000000-0000-0000-0000-00000000000b' and deleted_at is null),
           (select count(*)::int from public.control_button_panels
            where panel_id = 'c2000000-0000-0000-0000-00000000000b' and deleted_at is null),
           (select status from public.panel_commands where panel_id = 'c2000000-0000-0000-0000-00000000000b')$$,
  $$values (4, 1, 1, 'pending'::text)$$,
  'el panel activo de la misma instalación queda intacto');
select results_eq(
  $$select status, finished_at is not null from public.panel_commands
    where panel_id = 'c2000000-0000-0000-0000-00000000000a'$$,
  $$values ('expired'::text, true)$$,
  'las órdenes pendientes del panel huérfano quedan expiradas');
select is((select count(*)::int from public.outputs
           where panel_id = 'c2000000-0000-0000-0000-00000000000d' and deleted_at is null), 4,
  'el panel revocado de la misma instalación no se toca aquí (lo limpia revoke_panel)');

select ok(not public.reregister_revoked_panel('c2000000-0000-0000-0000-00000000000b', repeat('a', 64), '1', 6),
  'un panel que no está revocado devuelve false y no cambia');
select ok(public.reregister_revoked_panel('c2000000-0000-0000-0000-00000000000d', repeat('a', 64), '2.0', 7),
  'reregister_revoked_panel devuelve true para un panel revocado');
select results_eq(
  $$select status, installation_id is null, claim_code_hash, synced_revision, software_version, schema_version
    from public.panels where id = 'c2000000-0000-0000-0000-00000000000d'$$,
  $$values ('pending'::text, true, repeat('a', 64), 0::bigint, '2.0'::text, 7)$$,
  'el panel queda pending, sin instalación y con los datos nuevos');
select is((select count(*)::int from public.outputs
           where panel_id = 'c2000000-0000-0000-0000-00000000000d' and deleted_at is null), 0,
  'y sus salidas en la instalación anterior quedaron borradas');

select * from finish();
rollback;
