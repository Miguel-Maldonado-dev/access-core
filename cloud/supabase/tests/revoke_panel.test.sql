-- Pruebas de la revocación de un panel: public.revoke_panel y private.cleanup_revoked_panel.
-- Corren con `supabase test db`. Como postgres, auth.uid() es nulo (escritura del servidor).
begin;
select plan(14);

select ok(not has_function_privilege('authenticated', 'public.revoke_panel(uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.revoke_panel(uuid)', 'EXECUTE'),
  'authenticated y anon no ejecutan revoke_panel');
select ok(has_function_privilege('service_role', 'public.revoke_panel(uuid)', 'EXECUTE'),
  'service_role ejecuta revoke_panel');
select ok(not has_function_privilege('authenticated', 'private.cleanup_revoked_panel(uuid)', 'EXECUTE'),
  'authenticated no ejecuta cleanup_revoked_panel');

-- Datos base: una instalación con dos paneles activos (A se revoca, B no).
insert into public.tenants (id, name) values ('11000000-0000-0000-0000-00000000000a', 'Tenant R');
insert into public.installations (id, tenant_id, name) values
  ('21000000-0000-0000-0000-00000000000a', '11000000-0000-0000-0000-00000000000a', 'Fracc R');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c1000000-0000-0000-0000-00000000000a', 'PNL-RRRR-000A', repeat('2', 64), repeat('3', 64),
   '21000000-0000-0000-0000-00000000000a', 'active'),
  ('c1000000-0000-0000-0000-00000000000b', 'PNL-RRRR-000B', repeat('4', 64), repeat('5', 64),
   '21000000-0000-0000-0000-00000000000a', 'active');

insert into public.outputs (installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled,
                            updated_by, origin)
select '21000000-0000-0000-0000-00000000000a', p, i, 'Salida', 3000, 1, true, 'prueba', 'cloud'
from unnest(array['c1000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000000b']::uuid[]) p,
     generate_series(0, 3) i;

insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_by, origin) values
  ('41000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a', 'Perfil', 1, 'prueba', 'cloud');
insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                        pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute,
                                        updated_by, origin)
select '21000000-0000-0000-0000-00000000000a', '41000000-0000-0000-0000-00000000000a', p, 15, 15, 0, true, 127, 0, 0,
       'prueba', 'cloud'
from unnest(array['c1000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000000b']::uuid[]) p;

insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('31000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'prueba', 'cloud');
insert into public.controls (id, installation_id, holder_id, updated_by, origin) values
  ('51000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a',
   '31000000-0000-0000-0000-00000000000a', 'prueba', 'cloud');
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_by, origin) values
  ('61000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a',
   '51000000-0000-0000-0000-00000000000a', 0, 1234, 'prueba', 'cloud');
insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
select '21000000-0000-0000-0000-00000000000a', '61000000-0000-0000-0000-00000000000a', p, 0, 'prueba', 'cloud'
from unnest(array['c1000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000000b']::uuid[]) p;

insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
values ('11000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a',
        'c1000000-0000-0000-0000-00000000000a', 'test_output', 0, 'x', now() + interval '10 seconds'),
       ('11000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a',
        'c1000000-0000-0000-0000-00000000000b', 'test_output', 0, 'x', now() + interval '10 seconds');

insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason)
values ('11000000-0000-0000-0000-00000000000a', '21000000-0000-0000-0000-00000000000a',
        'c1000000-0000-0000-0000-00000000000a', 1, now() - interval '1 minute', true, 0, 0);

select ok(public.revoke_panel('c1000000-0000-0000-0000-00000000000a'), 'revoke_panel devuelve true');
select ok(not public.revoke_panel('c1000000-0000-0000-0000-0000000000ff'), 'un panel inexistente devuelve false');

select results_eq(
  $$select status, device_token_hash is null from public.panels where id = 'c1000000-0000-0000-0000-00000000000a'$$,
  $$values ('revoked'::text, true)$$,
  'el panel queda revocado y sin token');
select is((select count(*)::int from public.outputs
           where panel_id = 'c1000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'sus salidas quedan borradas');
select is((select count(*)::int from public.outputs
           where panel_id = 'c1000000-0000-0000-0000-00000000000a' and updated_by = 'system:revocacion'
             and origin = 'cloud'), 4,
  'el borrado se firma como system:revocacion');
select is((select count(*)::int from public.profile_panel_rules
           where panel_id = 'c1000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'sus reglas quedan borradas');
select is((select count(*)::int from public.control_button_panels
           where panel_id = 'c1000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'sus vínculos de botones quedan borrados');
select results_eq(
  $$select (select count(*)::int from public.outputs
            where panel_id = 'c1000000-0000-0000-0000-00000000000b' and deleted_at is null),
           (select count(*)::int from public.profile_panel_rules
            where panel_id = 'c1000000-0000-0000-0000-00000000000b' and deleted_at is null),
           (select count(*)::int from public.control_button_panels
            where panel_id = 'c1000000-0000-0000-0000-00000000000b' and deleted_at is null),
           (select status from public.panel_commands where panel_id = 'c1000000-0000-0000-0000-00000000000b')$$,
  $$values (4, 1, 1, 'pending'::text)$$,
  'el otro panel de la instalación no se toca');
select results_eq(
  $$select status, finished_at is not null from public.panel_commands
    where panel_id = 'c1000000-0000-0000-0000-00000000000a'$$,
  $$values ('expired'::text, true)$$,
  'las órdenes pendientes del panel quedan expiradas');
select results_eq(
  $$select (select count(*)::int from public.access_logs where panel_id = 'c1000000-0000-0000-0000-00000000000a'),
           (select deleted_at is null from public.control_buttons where id = '61000000-0000-0000-0000-00000000000a'),
           (select deleted_at is null from public.controls where id = '51000000-0000-0000-0000-00000000000a'),
           (select deleted_at is null from public.holders where id = '31000000-0000-0000-0000-00000000000a')$$,
  $$values (1, true, true, true)$$,
  'conserva los logs, el botón, el control y el titular');

select lives_ok($$select public.revoke_panel('c1000000-0000-0000-0000-00000000000a')$$,
  'revocar de nuevo es idempotente');

select * from finish();
rollback;
