-- Pruebas de logs_listen_retention: filtro de logs entrantes, "Borrar logs" (purge_installation_logs,
-- log_purges), escucha de RF en panel_commands y retención. Corren con `supabase test db`.
begin;
select plan(23);

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-a@test.local');
insert into public.tenants (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'tecnico');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Fracc B');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('2', 64), repeat('3', 64),
   '20000000-0000-0000-0000-00000000000a', 'active'),
  ('c0000000-0000-0000-0000-00000000000b', 'PNL-BBBB-000B', repeat('2', 64), repeat('4', 64),
   '20000000-0000-0000-0000-00000000000b', 'active');

-- ---------------------------------------------------------------------------
-- Filtro de entrada
-- ---------------------------------------------------------------------------
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 1, now(), true, 0, 5),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 2, now(), true, 0, 1),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 3, now() - interval '31 days', true, 0, 1),
  ('10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b',
   'c0000000-0000-0000-0000-00000000000b', 1, now(), true, 0, 1);
select is((select count(*)::int from public.access_logs where local_log_id = 1 and panel_id = 'c0000000-0000-0000-0000-00000000000a'),
  0, 'un log con reason 5 no se guarda');
select is((select count(*)::int from public.access_logs where local_log_id = 2), 1, 'un log con reason 1 se guarda');
select is((select count(*)::int from public.access_logs where local_log_id = 3), 0, 'un log de hace 31 días no se guarda');

-- ---------------------------------------------------------------------------
-- Borrado
-- ---------------------------------------------------------------------------
select is(public.purge_installation_logs('20000000-0000-0000-0000-00000000000a',
  '00000000-0000-0000-0000-0000000000a1', 'tecnico-a@test.local'), 1, 'purge devuelve el conteo borrado');
select is((select count(*)::int from public.access_logs where installation_id = '20000000-0000-0000-0000-00000000000a'),
  0, 'purge borra los logs de la instalación');
select is((select count(*)::int from public.access_logs where installation_id = '20000000-0000-0000-0000-00000000000b'),
  1, 'purge no toca otra instalación');
select ok((select logs_cleared_at is not null from public.installations where id = '20000000-0000-0000-0000-00000000000a'),
  'purge fija logs_cleared_at');
select is((select deleted_count from public.log_purges where installation_id = '20000000-0000-0000-0000-00000000000a'), 1,
  'purge inserta en log_purges con el conteo');
select is((select purged_by_label from public.log_purges where installation_id = '20000000-0000-0000-0000-00000000000a'),
  'tecnico-a@test.local', 'log_purges guarda quién borró');

select throws_ok($$select public.purge_installation_logs('20000000-0000-0000-0000-0000000000ff', null, null)$$,
  'P0002', 'instalación no encontrada', 'purge de una instalación inexistente falla');

-- Frontera: un log con ts exactamente igual a logs_cleared_at no se guarda.
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason)
  select '10000000-0000-0000-0000-00000000000a', i.id, 'c0000000-0000-0000-0000-00000000000a', 12,
         i.logs_cleared_at, true, 0, 1
  from public.installations i where i.id = '20000000-0000-0000-0000-00000000000a';
select is((select count(*)::int from public.access_logs where local_log_id = 12), 0,
  'un log con ts = logs_cleared_at no se guarda');

-- Tras el borrado: lo anterior a la marca no se guarda; lo posterior, sí.
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 10, now() - interval '1 hour', true, 0, 1),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 11, now() + interval '1 hour', true, 0, 1);
select results_eq($$select local_log_id from public.access_logs where installation_id = '20000000-0000-0000-0000-00000000000a'$$,
  $$values (11::bigint)$$, 'después del borrado solo entra el log posterior a la marca');

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.purge_installation_logs(uuid, uuid, text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.purge_installation_logs(uuid, uuid, text)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.purge_installation_logs(uuid, uuid, text)', 'EXECUTE'),
  'solo service_role ejecuta purge_installation_logs');

insert into public.log_purges (tenant_id, installation_id, deleted_count) values
  ('10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b', 5);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select count(*)::int from public.log_purges), 1, 'un miembro lee solo los log_purges de su tenant');
select throws_ok($$select public.purge_installation_logs('20000000-0000-0000-0000-00000000000a', null, null)$$,
  '42501', null, 'authenticated no ejecuta purge_installation_logs');
select throws_ok($$delete from public.log_purges$$, '42501', null, 'authenticated no escribe log_purges');
reset role;

-- ---------------------------------------------------------------------------
-- Escucha de RF
-- ---------------------------------------------------------------------------
insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, requested_by, expires_at)
values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
        'c0000000-0000-0000-0000-00000000000a', 'listen_rf', 'x', now() + interval '30 seconds');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'listen_rf', 'y', now() + interval '30 seconds')$$,
  '23505', null, 'dos listen_rf pendientes del mismo panel violan el índice');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'listen_rf', 1, 'y', now() + interval '30 seconds')$$,
  '23514', null, 'listen_rf con output_index viola el check');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 'y', now() + interval '10 seconds')$$,
  '23514', null, 'test_output sin output_index viola el check');
select throws_ok(
  $$update public.panel_commands set rf_code = 4294967296 where kind = 'listen_rf'$$,
  '23514', null, 'rf_code fuera de rango viola el check');
select ok(has_column_privilege('authenticated', 'public.panel_commands', 'rf_code', 'SELECT')
          and has_column_privilege('authenticated', 'public.installations', 'logs_cleared_at', 'SELECT'),
  'authenticated lee rf_code y logs_cleared_at');

-- ---------------------------------------------------------------------------
-- Retención
-- ---------------------------------------------------------------------------
select has_index('public', 'access_logs', 'access_logs_ts_idx', 'índice por fecha');
select is((select count(*)::int from cron.job where jobname = 'access-logs-retention'), 1,
  'existe el trabajo access-logs-retention');

select * from finish();
rollback;
