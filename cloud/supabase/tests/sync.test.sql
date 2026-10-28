-- Pruebas de device_changes, sync_conflicts y apply_panel_change (N7): estructura,
-- privilegios y RLS. El comportamiento de la sincronización lo cubre Vitest
-- (tests/device/push.test.ts). Corren con `supabase test db` en el stack local.
begin;
select plan(27);

-- ---------------------------------------------------------------------------
-- Datos base
-- ---------------------------------------------------------------------------
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
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'x', 'cloud'),
  ('30000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b', 'persona', 'Beto', 'x', 'cloud');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.device_changes'::regclass),
  'RLS activa en device_changes');
select ok((select relrowsecurity from pg_class where oid = 'public.sync_conflicts'::regclass),
  'RLS activa en sync_conflicts');
select col_is_pk('public', 'device_changes', array['panel_id', 'change_id'],
  'device_changes es idempotente por (panel_id, change_id)');
select columns_are('public', 'sync_conflicts',
  array['id', 'tenant_id', 'installation_id', 'panel_id', 'table_name', 'row_id', 'kind', 'cloud_version',
        'panel_version', 'resolution', 'created_at', 'reviewed_at', 'reviewed_by'],
  'sync_conflicts tiene exactamente las columnas del contrato');
select has_index('public', 'sync_conflicts', 'sync_conflicts_installation_id_created_at_idx',
  array['installation_id', 'created_at'], 'indice para listar los conflictos de una instalacion por fecha');
select throws_ok(
  $$insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind, resolution)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'cards', gen_random_uuid(), 'otro', 'x')$$,
  '23514', null, 'kind solo admite lww, unique o skew');

-- ---------------------------------------------------------------------------
-- apply_panel_change como servidor (aquí, postgres)
-- ---------------------------------------------------------------------------
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'cambio-1', 'cards', 'upsert',
    '40000000-0000-0000-0000-00000000000a', now() - interval '1 minute', false,
    '{"card_code": 1001, "holder_id": "30000000-0000-0000-0000-00000000000a", "description": ""}',
    '{"op": "upsert"}') ->> 'status',
  'applied', 'un alta de tarjeta queda applied');
select is(
  (select result from public.device_changes
   where panel_id = 'c0000000-0000-0000-0000-00000000000a' and change_id = 'cambio-1'),
  jsonb_build_object('status', 'applied',
    'revision', (select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a')),
  'device_changes guarda {status, revision} con la revision de la instalacion');
select results_eq(
  $$select origin, updated_by from public.cards where id = '40000000-0000-0000-0000-00000000000a'$$,
  $$values ('panel:PNL-AAAA-000A'::text, 'panel:PNL-AAAA-000A'::text)$$,
  'la fila queda escrita como cambio del panel');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'cambio-1', 'cards', 'delete',
    '40000000-0000-0000-0000-00000000000a', now(), false, null, '{"op": "delete"}'),
  (select result from public.device_changes
   where panel_id = 'c0000000-0000-0000-0000-00000000000a' and change_id = 'cambio-1'),
  'un change_id repetido devuelve el resultado guardado');
select is((select deleted_at from public.cards where id = '40000000-0000-0000-0000-00000000000a'), null::timestamptz,
  'y no aplica el cambio repetido');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000b', 'cambio-2', 'holders', 'upsert',
    '30000000-0000-0000-0000-00000000000a', now(), true,
    '{"kind": "persona", "name": "Intruso", "department": "", "address": "", "notes": "",
      "pin_ciphertext": null, "pin_lookup": null}',
    '{"op": "upsert"}'),
  '{"status": "rejected", "reason": "no encontrado"}'::jsonb,
  'un panel de B no modifica un titular de A');
select is((select name from public.holders where id = '30000000-0000-0000-0000-00000000000a'), 'Ana',
  'el titular de A no cambia');
select results_eq(
  $$select tenant_id, installation_id, kind from public.sync_conflicts
    where panel_id = 'c0000000-0000-0000-0000-00000000000b'$$,
  $$values ('10000000-0000-0000-0000-00000000000b'::uuid, '20000000-0000-0000-0000-00000000000b'::uuid, 'skew'::text)$$,
  'el conflicto skew queda en el tenant y la instalacion del panel que lo envio');
select throws_ok(
  $$select public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'cambio-3', 'panels', 'delete',
      gen_random_uuid(), now(), false, null, null)$$,
  '22023', null, 'una tabla fuera del contrato se rechaza');

-- Un conflicto de cada tenant para probar RLS.
insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind, resolution) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 'cards', '40000000-0000-0000-0000-0000000000a1', 'lww', 'x');

-- ---------------------------------------------------------------------------
-- authenticated (técnico del tenant A)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select results_eq(
  $$select row_id from public.sync_conflicts$$,
  $$values ('40000000-0000-0000-0000-0000000000a1'::uuid)$$,
  'un miembro de A ve solo los conflictos de A');
select throws_ok(
  $$insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind, resolution)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'cards', gen_random_uuid(), 'lww', 'x')$$,
  '42501', null, 'authenticated no puede crear conflictos');
select throws_ok($$update public.sync_conflicts set resolution = 'y'$$, '42501', null,
  'authenticated no puede modificar conflictos');
select throws_ok($$delete from public.sync_conflicts$$, '42501', null,
  'authenticated no puede borrar conflictos');
select throws_ok($$select * from public.device_changes$$, '42501', null,
  'authenticated no puede leer device_changes');
select throws_ok(
  $$select public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'cambio-4', 'cards', 'delete',
      gen_random_uuid(), now(), false, null, null)$$,
  '42501', null, 'authenticated no puede ejecutar apply_panel_change');
select throws_ok(
  $$select private.push_row('cards', '20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a',
      'delete', gen_random_uuid(), now(), 'x', null)$$,
  '42501', null, 'authenticated no puede ejecutar los auxiliares de private');
reset role;

-- ---------------------------------------------------------------------------
-- anon
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$select id from public.sync_conflicts$$, '42501', null, 'anon no puede leer sync_conflicts');
select throws_ok($$select change_id from public.device_changes$$, '42501', null,
  'anon no puede leer device_changes');
select throws_ok(
  $$select public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'cambio-5', 'cards', 'delete',
      gen_random_uuid(), now(), false, null, null)$$,
  '42501', null, 'anon no puede ejecutar apply_panel_change');
reset role;

-- ---------------------------------------------------------------------------
-- service_role (la llave secreta)
-- ---------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'cambio-6', 'cards', 'delete',
    '40000000-0000-0000-0000-00000000000a', now(), false, null, '{"op": "delete"}') ->> 'status',
  'applied', 'service_role ejecuta apply_panel_change');
select is(
  (select count(*)::int from public.device_changes
   where panel_id in ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000b')),
  3, 'service_role lee device_changes');
reset role;

select * from finish();
rollback;
