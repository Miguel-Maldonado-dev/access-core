-- Pruebas de panel_imports y de las funciones de importación al vincular (N8):
-- estructura, privilegios y las ramas de import_panel_snapshot, stage_panel_import y
-- confirm_panel_import. El flujo completo lo cubre Vitest (tests/device/import.test.ts).
-- Corren con `supabase test db` en el stack local.
begin;
select plan(24);

-- ---------------------------------------------------------------------------
-- Datos base
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@test.local');

insert into public.tenants (id, name) values ('10000000-0000-0000-0000-00000000000a', 'Tenant A');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'admin');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Vacia'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000a', 'Con datos');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('2', 64), repeat('3', 64),
   '20000000-0000-0000-0000-00000000000a', 'staging'),
  ('c0000000-0000-0000-0000-00000000000b', 'PNL-BBBB-000B', repeat('2', 64), repeat('4', 64),
   '20000000-0000-0000-0000-00000000000b', 'staging'),
  ('c0000000-0000-0000-0000-00000000000c', 'PNL-CCCC-000C', repeat('2', 64), repeat('5', 64),
   '20000000-0000-0000-0000-00000000000b', 'active');
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b', 'persona', 'Beto', 'x', 'cloud');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.panel_imports'::regclass),
  'RLS activa en panel_imports');
select columns_are('public', 'panel_imports', array['panel_id', 'snapshot', 'diff', 'created_at'],
  'panel_imports tiene exactamente las columnas del plan');
select col_is_pk('public', 'panel_imports', 'panel_id', 'una importacion pendiente por panel');
select fk_ok('public', 'panel_imports', 'panel_id', 'public', 'panels', 'id',
  'panel_imports.panel_id apunta a panels');

-- ---------------------------------------------------------------------------
-- Ramas de las funciones (como servidor; aquí, postgres)
-- ---------------------------------------------------------------------------
select is(
  public.import_panel_snapshot('c0000000-0000-0000-0000-00000000000c', '{}'), 'not_staging',
  'import_panel_snapshot no importa un panel que no esta en staging');
select is(
  public.import_panel_snapshot('c0000000-0000-0000-0000-00000000000b',
    '{"holders": [{"id": "40000000-0000-0000-0000-00000000000b", "kind": "persona", "name": "Ana",
       "department": "", "address": "", "notes": "", "pin_ciphertext": null, "pin_lookup": null}]}'),
  'not_empty', 'con datos vivos en la instalacion devuelve not_empty');
select is((select count(*)::int from public.holders where installation_id = '20000000-0000-0000-0000-00000000000b'),
  1, 'y no escribe nada');
select is(
  public.import_panel_snapshot('c0000000-0000-0000-0000-00000000000a',
    '{"holders": [{"id": "30000000-0000-0000-0000-00000000000b", "kind": "persona", "name": "Ana",
       "department": "", "address": "", "notes": "", "pin_ciphertext": null, "pin_lookup": null}],
      "cards": [{"id": "50000000-0000-0000-0000-00000000000a", "card_code": 77,
       "holder_id": "30000000-0000-0000-0000-00000000000b", "description": ""}]}'),
  'imported', 'una instalacion vacia se importa');
select results_eq(
  $$select h.origin, h.updated_by, h.id <> '30000000-0000-0000-0000-00000000000b'::uuid, c.holder_id = h.id
      from public.holders h join public.cards c on c.installation_id = h.installation_id
     where h.installation_id = '20000000-0000-0000-0000-00000000000a'$$,
  $$values ('panel:PNL-AAAA-000A'::text, 'panel:PNL-AAAA-000A'::text, true, true)$$,
  'como cambio del panel; un id que ya existe en otra instalacion recibe otro y sus referencias lo siguen');
select is((select status from public.panels where id = 'c0000000-0000-0000-0000-00000000000a'), 'active',
  'el panel importado queda active');
select is((select name from public.holders where id = '30000000-0000-0000-0000-00000000000b'), 'Beto',
  'el titular de la otra instalacion no cambia');

select is(
  public.stage_panel_import('c0000000-0000-0000-0000-00000000000c', '{}', '{}'), 'not_staging',
  'stage_panel_import no guarda nada de un panel fuera de staging');
select is(
  public.stage_panel_import('c0000000-0000-0000-0000-00000000000b', '{"holders": []}',
    '{"onlyInPanel": [], "conflicts": []}'),
  'awaiting_review', 'stage_panel_import guarda el snapshot y el diff');
select is((select status from public.panels where id = 'c0000000-0000-0000-0000-00000000000b'), 'awaiting_review',
  'y deja el panel en awaiting_review');
select is(
  public.confirm_panel_import('c0000000-0000-0000-0000-00000000000b', '{}',
    (select revision - 1 from public.installations where id = '20000000-0000-0000-0000-00000000000b')),
  'stale', 'confirm_panel_import no escribe si la instalacion cambio desde que se armo el plan');
select is(
  public.confirm_panel_import('c0000000-0000-0000-0000-00000000000c', '{}', 0), 'not_awaiting',
  'confirm_panel_import no confirma un panel que no esta en awaiting_review');

-- ---------------------------------------------------------------------------
-- authenticated (admin del tenant A) y anon
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select throws_ok($$select diff from public.panel_imports$$, '42501', null,
  'authenticated no lee panel_imports (ni siquiera de su tenant)');
select throws_ok(
  $$insert into public.panel_imports (panel_id, snapshot, diff)
    values ('c0000000-0000-0000-0000-00000000000c', '{}', '{}')$$,
  '42501', null, 'authenticated no escribe panel_imports');
select throws_ok(
  $$select public.confirm_panel_import('c0000000-0000-0000-0000-00000000000b', '{}', 0)$$,
  '42501', null, 'authenticated no puede ejecutar confirm_panel_import');
select throws_ok(
  $$select public.import_panel_snapshot('c0000000-0000-0000-0000-00000000000b', '{}')$$,
  '42501', null, 'authenticated no puede ejecutar import_panel_snapshot');
select throws_ok(
  $$select private.import_rows('20000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-00000000000b',
      'x', '{}')$$,
  '42501', null, 'authenticated no puede ejecutar los auxiliares de private');
reset role;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok($$select panel_id from public.panel_imports$$, '42501', null, 'anon no lee panel_imports');
select throws_ok(
  $$select public.stage_panel_import('c0000000-0000-0000-0000-00000000000b', '{}', '{}')$$,
  '42501', null, 'anon no puede ejecutar stage_panel_import');
reset role;

-- ---------------------------------------------------------------------------
-- service_role (la llave secreta)
-- ---------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is((select diff from public.panel_imports where panel_id = 'c0000000-0000-0000-0000-00000000000b'),
  '{"onlyInPanel": [], "conflicts": []}'::jsonb, 'service_role lee panel_imports');
reset role;

select * from finish();
rollback;
