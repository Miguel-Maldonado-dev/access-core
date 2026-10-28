-- Pruebas de access_logs y de la retencion con pg_cron (N9): estructura, privilegios,
-- RLS, el trabajo mensual y el comando que ejecuta. Corren con `supabase test db`.
begin;
select plan(17);

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
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.access_logs'::regclass),
  'RLS activa en access_logs');
select columns_are('public', 'access_logs',
  array['id', 'tenant_id', 'installation_id', 'panel_id', 'local_log_id', 'ts', 'allowed', 'source', 'reason',
        'holder_id', 'holder_name', 'holder_kind', 'credential_label', 'control_id', 'code', 'device_id',
        'output_index'],
  'access_logs tiene exactamente las columnas del contrato');
select ok(exists (
  select 1 from pg_constraint
  where conrelid = 'public.access_logs'::regclass and contype = 'u'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'public.access_logs'::regclass and attname = 'panel_id'),
                       (select attnum from pg_attribute where attrelid = 'public.access_logs'::regclass and attname = 'local_log_id')]::smallint[]),
  'unique (panel_id, local_log_id)');
select has_index('public', 'access_logs', 'access_logs_installation_id_ts_idx', 'indice por instalacion y fecha');
select has_index('public', 'access_logs', 'access_logs_panel_id_ts_idx', 'indice por panel y fecha');
select throws_ok(
  $$insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason, code)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 1, now(), true, 3, 0, 1234)$$,
  '23514', null, 'un log de PIN (source 3) no puede traer code');

-- ---------------------------------------------------------------------------
-- RLS y privilegios
-- ---------------------------------------------------------------------------
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 10, now(), true, 0, 0),
  ('10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b',
   'c0000000-0000-0000-0000-00000000000b', 10, now(), true, 0, 0);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select count(*)::int from public.access_logs), 1, 'un miembro solo lee los logs de su tenant');
select throws_ok(
  $$insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 11, now(), true, 0, 0)$$,
  '42501', null, 'authenticated no escribe access_logs');
select throws_ok($$delete from public.access_logs$$, '42501', null, 'authenticated no borra access_logs');
reset role;

set local role anon;
select throws_ok($$select id from public.access_logs$$, '42501', null, 'anon no lee access_logs');
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is((select count(*)::int from public.access_logs), 2, 'service_role lee todos los logs');
reset role;

-- ---------------------------------------------------------------------------
-- Retencion: trabajo de pg_cron
-- ---------------------------------------------------------------------------
select has_extension('pg_cron', 'pg_cron esta habilitada');
select is((select count(*)::int from cron.job where jobname = 'access-logs-retention'), 1,
  'existe un solo trabajo access-logs-retention');
select is((select schedule from cron.job where jobname = 'access-logs-retention'), '0 3 1 * *',
  'corre el dia 1 de cada mes');
select ok((select command from cron.job where jobname = 'access-logs-retention') ilike '%access_logs%12 months%',
  'el comando borra los logs de mas de 12 meses');

delete from public.access_logs;
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 1, now() - interval '13 months', true, 0, 0),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 2, now() - interval '11 months', true, 0, 0);
do $$
begin
  execute (select command from cron.job where jobname = 'access-logs-retention');
end $$;
select results_eq($$select local_log_id from public.access_logs$$, $$values (2::bigint)$$,
  'el comando del trabajo borra solo el log de 13 meses');
select is((select count(*)::int from public.access_logs), 1, 'y conserva el de 11 meses');

select * from finish();
rollback;
