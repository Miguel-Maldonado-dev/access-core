-- Pruebas de panel_commands (órdenes de la nube a los paneles), panels.logs_uploaded_at e
-- installations.logs_requested_at. Corren con `supabase test db` en el stack local.
-- Como postgres, auth.uid() es nulo: equivale a una escritura del servidor (llave secreta).
begin;
select plan(30);

-- ---------------------------------------------------------------------------
-- Datos base
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-b@test.local');
insert into public.tenants (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'tecnico'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'admin');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Fracc B');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('2', 64), repeat('3', 64),
   '20000000-0000-0000-0000-00000000000a', 'active'),
  ('c0000000-0000-0000-0000-00000000000b', 'PNL-BBBB-000B', repeat('2', 64), repeat('4', 64),
   '20000000-0000-0000-0000-00000000000b', 'active');

-- ---------------------------------------------------------------------------
-- Estructura de panel_commands
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.panel_commands'::regclass),
  'RLS activa en panel_commands');
select columns_are('public', 'panel_commands',
  array['id', 'tenant_id', 'installation_id', 'panel_id', 'kind', 'output_index', 'requested_by',
        'requested_by_user', 'created_at', 'expires_at', 'status', 'detail', 'finished_at'],
  'panel_commands tiene exactamente las columnas del diseño');
select fk_ok('public', 'panel_commands', array['panel_id'], 'public', 'panels', array['id'],
  'panel_commands.panel_id es FK hacia panels(id)');
select has_index('public', 'panel_commands', 'panel_commands_panel_id_output_index_status_idx',
  array['panel_id', 'output_index', 'status'], 'índice (panel_id, output_index, status)');

insert into public.panel_commands (id, tenant_id, installation_id, panel_id, kind, output_index, requested_by,
                                   requested_by_user, expires_at) values
  ('d0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a',
   '20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a', 'test_output', 0,
   'tecnico-a@test.local', '00000000-0000-0000-0000-0000000000a1', now() + interval '10 seconds'),
  ('d0000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b',
   '20000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-00000000000b', 'test_output', 1,
   'admin-b@test.local', '00000000-0000-0000-0000-0000000000b1', now() + interval '10 seconds');

select is((select status from public.panel_commands where id = 'd0000000-0000-0000-0000-00000000000a'), 'pending',
  'una orden nueva queda pending');
select ok((select created_at is not null and finished_at is null and detail is null
           from public.panel_commands where id = 'd0000000-0000-0000-0000-00000000000a'),
  'created_at se llena solo; finished_at y detail empiezan nulos');

select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'open', 1, 'x', now())$$,
  '23514', null, 'kind solo admite test_output');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 4, 'x', now())$$,
  '23514', null, 'output_index va de 0 a 3');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at, status)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 1, 'x', now(), 'raro')$$,
  '23514', null, 'status solo admite pending, ok, error o expired');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 1, now())$$,
  '23502', null, 'requested_by es obligatorio');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 1, 'x')$$,
  '23502', null, 'expires_at es obligatorio');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000b', 'test_output', 1, 'x', now())$$,
  '23503', null, 'el panel debe ser de la instalación de la orden');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 0, 'x', now() + interval '10 seconds')$$,
  '23505', null, 'una sola orden pending por panel y salida');
select throws_ok(
  $$update public.panel_commands set status = 'ok' where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  '23514', null, 'una orden terminada lleva finished_at');
select lives_ok(
  $$update public.panel_commands set status = 'ok', finished_at = now()
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'el servidor marca la orden como ok con finished_at');
select lives_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 0, 'x', now() + interval '10 seconds')$$,
  'terminada la anterior, la salida acepta otra orden pending');

-- ---------------------------------------------------------------------------
-- RLS y privilegios de panel_commands
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select count(*)::int from public.panel_commands), 2, 'un miembro lee las órdenes de su tenant');
select is((select count(*)::int from public.panel_commands where tenant_id = '10000000-0000-0000-0000-00000000000b'),
  0, 'y no las de otro tenant');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 2, 'x', now())$$,
  '42501', null, 'authenticated no crea órdenes');
select throws_ok($$update public.panel_commands set detail = 'x'$$, '42501', null, 'authenticated no modifica órdenes');
select throws_ok($$delete from public.panel_commands$$, '42501', null, 'authenticated no borra órdenes');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select results_eq($$select id from public.panel_commands$$,
  $$values ('d0000000-0000-0000-0000-00000000000b'::uuid)$$, 'un miembro del tenant B solo lee la suya');
reset role;

set local role anon;
select throws_ok($$select id from public.panel_commands$$, '42501', null, 'anon no lee panel_commands');
reset role;

-- ---------------------------------------------------------------------------
-- panels.logs_uploaded_at e installations.logs_requested_at
-- ---------------------------------------------------------------------------
select has_column('public', 'panels', 'logs_uploaded_at', 'panels guarda la hora de la última subida de logs');
select col_type_is('public', 'panels', 'logs_uploaded_at', 'timestamp with time zone', 'logs_uploaded_at es timestamptz');
select ok(has_column_privilege('authenticated', 'public.panels', 'logs_uploaded_at', 'SELECT'),
  'authenticated lee panels.logs_uploaded_at');
select ok(not has_column_privilege('authenticated', 'public.panels', 'logs_uploaded_at', 'UPDATE'),
  'authenticated no escribe panels.logs_uploaded_at');
select has_column('public', 'installations', 'logs_requested_at',
  'installations guarda la hora de la última petición de logs');
select col_type_is('public', 'installations', 'logs_requested_at', 'timestamp with time zone',
  'logs_requested_at es timestamptz');
select ok(not has_column_privilege('authenticated', 'public.installations', 'logs_requested_at', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.installations', 'logs_requested_at', 'INSERT'),
  'authenticated no escribe installations.logs_requested_at (solo el service_role)');

select * from finish();
rollback;
