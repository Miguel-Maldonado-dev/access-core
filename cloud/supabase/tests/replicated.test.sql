-- Pruebas de tablas replicadas, revisión, borrado lógico en cascada y auditoría (N3).
-- Corren con `supabase test db` en el stack local.
-- Como postgres, auth.uid() es nulo: equivale a una escritura del servidor (llave secreta),
-- que trae updated_by/origin explícitos.
begin;
select plan(72);

-- ---------------------------------------------------------------------------
-- Datos base
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-b@test.local');

insert into public.tenants (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'tecnico'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'admin');

-- IA e IA2 son del tenant A; IB del tenant B.
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', 'Fracc A2'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Fracc B');

-- Paneles de IA a los que apuntan las reglas y salidas (FK de N5).
insert into public.panels (id, panel_code, panel_secret_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-0000000000aa', 'PNL-TEST-00AA', repeat('a', 64), '20000000-0000-0000-0000-00000000000a', 'claimed'),
  ('c0000000-0000-0000-0000-0000000000bb', 'PNL-TEST-00BB', repeat('b', 64), '20000000-0000-0000-0000-00000000000a', 'claimed');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class
   where relnamespace = 'public'::regnamespace and relrowsecurity
     and relname in ('holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                     'holder_profiles', 'profile_panel_rules', 'outputs', 'audit_log')),
  9, 'RLS activa en las 8 tablas replicadas y en audit_log');
select columns_are('public', 'audit_log',
  array['id', 'tenant_id', 'table_name', 'row_id', 'op', 'updated_by', 'at'],
  'audit_log tiene exactamente las columnas del contrato');
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'audit_log' and column_name ilike '%pin%'),
  0, 'audit_log no tiene columna con PIN');
select is(
  (select count(*)::int from pg_indexes
   where schemaname = 'public'
     and tablename in ('holders', 'cards', 'controls', 'control_buttons', 'access_profiles',
                       'holder_profiles', 'profile_panel_rules', 'outputs')
     and indexdef like 'CREATE UNIQUE INDEX % WHERE (deleted_at IS NULL)'),
  8, 'existen los 8 indices unicos parciales sobre registros vivos');

-- ---------------------------------------------------------------------------
-- Revisión por instalación (escrituras del servidor)
-- ---------------------------------------------------------------------------
insert into public.holders (id, installation_id, kind, name, pin_ciphertext, pin_lookup, updated_by, origin)
values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 'persona', 'Ana',
        'cifrado-1', 'lookup-1', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select is((select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a'), 1::bigint,
  'la primera escritura sube installations.revision a 1');
select is((select revision from public.holders where id = '30000000-0000-0000-0000-000000000001'), 1::bigint,
  'la fila guarda la revision asignada (1)');

-- El tenant_id que mande el servidor se ignora: lo pone el trigger desde la instalación.
insert into public.holders (id, installation_id, tenant_id, kind, name, updated_by, origin)
values ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-00000000000a',
        '10000000-0000-0000-0000-00000000000b', 'domicilio', 'Casa 2', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select is((select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a'), 2::bigint,
  'la segunda escritura sube installations.revision a 2');
select is((select revision from public.holders where id = '30000000-0000-0000-0000-000000000002'), 2::bigint,
  'la segunda fila guarda la revision 2');
select is((select tenant_id from public.holders where id = '30000000-0000-0000-0000-000000000002'),
  '10000000-0000-0000-0000-00000000000a'::uuid, 'tenant_id lo pone el trigger desde la instalacion');
select results_eq(
  $$select updated_by, origin from public.holders where id = '30000000-0000-0000-0000-000000000001'$$,
  $$values ('panel:PNL-TEST-0001'::text, 'panel:PNL-TEST-0001'::text)$$,
  'una escritura del servidor conserva updated_by y origin explicitos');

update public.holders set notes = 'nota', updated_by = 'panel:PNL-TEST-0001', origin = 'panel:PNL-TEST-0001'
where id = '30000000-0000-0000-0000-000000000002';
select is((select revision from public.holders where id = '30000000-0000-0000-0000-000000000002'), 3::bigint,
  'una actualizacion tambien asigna revision nueva');

select throws_ok(
  $$insert into public.holders (installation_id, kind, name, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'persona', 'Sin autor', 'cloud')$$,
  '23502', null, 'el servidor debe mandar updated_by');
select throws_ok(
  $$insert into public.holders (installation_id, kind, name, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'persona', 'Origen raro', 'x', 'otro')$$,
  '23514', null, 'origin solo admite cloud o panel:<codigo>');
select throws_ok(
  $$insert into public.holders (installation_id, kind, name, updated_by, origin)
    values ('29999999-0000-0000-0000-000000000000', 'persona', 'Huerfano', 'x', 'cloud')$$,
  '23503', null, 'una instalacion inexistente se rechaza');
select throws_ok(
  $$update public.holders set installation_id = '20000000-0000-0000-0000-0000000000a2'
    where id = '30000000-0000-0000-0000-000000000001'$$,
  '23000', null, 'una fila no puede cambiar de instalacion (ni desde el servidor)');

-- Datos de las otras instalaciones
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a2', 'persona', 'Beto', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001'),
  ('30000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-00000000000b', 'persona', 'Bruno', 'panel:PNL-TEST-0009', 'panel:PNL-TEST-0009');
select is((select revision from public.installations where id = '20000000-0000-0000-0000-0000000000a2'), 1::bigint,
  'cada instalacion lleva su propia revision');

-- ---------------------------------------------------------------------------
-- Unicidad sobre registros vivos
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into public.cards (id, installation_id, card_code, holder_id, updated_by, origin)
    values ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 1234,
            '30000000-0000-0000-0000-000000000001', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001')$$,
  'alta de tarjeta 1234');
select throws_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 1234, '30000000-0000-0000-0000-000000000002',
            'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001')$$,
  '23505', null, 'dos tarjetas vivas con el mismo card_code en la misma instalacion fallan');
update public.cards set deleted_at = now(), updated_by = 'panel:PNL-TEST-0001', origin = 'panel:PNL-TEST-0001'
where id = '40000000-0000-0000-0000-000000000001';
select lives_ok(
  $$insert into public.cards (id, installation_id, card_code, holder_id, updated_by, origin)
    values ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-00000000000a', 1234,
            '30000000-0000-0000-0000-000000000002', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001')$$,
  'si la primera tarjeta esta borrada, el mismo card_code se permite');
select lives_ok(
  $$insert into public.cards (id, installation_id, card_code, holder_id, updated_by, origin) values
    ('40000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a2', 1234,
     '30000000-0000-0000-0000-000000000003', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001'),
    ('40000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-00000000000b', 1234,
     '30000000-0000-0000-0000-0000000000b1', 'panel:PNL-TEST-0009', 'panel:PNL-TEST-0009')$$,
  'el mismo card_code en otra instalacion se permite');
select throws_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 4294967296, '30000000-0000-0000-0000-000000000002', 'x', 'cloud')$$,
  '23514', null, 'card_code fuera de 0..4294967295 se rechaza');

insert into public.controls (id, installation_id, holder_id, updated_by, origin)
values ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-000000000001', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, output_index, updated_by, origin)
values ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a',
        '50000000-0000-0000-0000-000000000001', 0, 5555, 0, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select throws_ok(
  $$insert into public.control_buttons (installation_id, control_id, button, rf_code, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 1, 5555, 'x', 'cloud')$$,
  '23505', null, 'rf_code vivo duplicado en la instalacion falla');
select throws_ok(
  $$insert into public.control_buttons (installation_id, control_id, button, rf_code, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 0, 6666, 'x', 'cloud')$$,
  '23505', null, 'el mismo boton vivo dos veces en un control falla');
select throws_ok(
  $$insert into public.holders (installation_id, kind, name, pin_ciphertext, pin_lookup, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'persona', 'Otro PIN', 'cifrado-x', 'lookup-1', 'x', 'cloud')$$,
  '23505', null, 'pin_lookup vivo duplicado en la instalacion falla');
select throws_ok(
  $$insert into public.holders (installation_id, kind, name, pin_ciphertext, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'persona', 'PIN a medias', 'cifrado-y', 'x', 'cloud')$$,
  '23514', null, 'pin_ciphertext y pin_lookup van juntos');

insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_by, origin) values
  ('70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 'Residente', 0, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001'),
  ('70000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a2', 'Servicio', 0, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select throws_ok(
  $$insert into public.access_profiles (installation_id, name, local_permission_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'Repetido', 0, 'x', 'cloud')$$,
  '23505', null, 'local_permission_id vivo duplicado en la instalacion falla');

-- ---------------------------------------------------------------------------
-- Integridad entre instalaciones y con padres borrados
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-0000000000a2', 999, '30000000-0000-0000-0000-000000000001', 'x', 'cloud')$$,
  '23503', null, 'una tarjeta no puede apuntar a un titular de otra instalacion');
select throws_ok(
  $$insert into public.control_buttons (installation_id, control_id, button, rf_code, updated_by, origin)
    values ('20000000-0000-0000-0000-0000000000a2', '50000000-0000-0000-0000-000000000001', 2, 999, 'x', 'cloud')$$,
  '23503', null, 'un boton no puede apuntar a un control de otra instalacion');
select throws_ok(
  $$insert into public.holder_profiles (installation_id, holder_id, profile_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000001',
            '70000000-0000-0000-0000-000000000002', 'x', 'cloud')$$,
  '23503', null, 'un holder_profile no puede apuntar a un perfil de otra instalacion');
select throws_ok(
  $$insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
      pin_reader_mask, weekday_mask, start_minute, end_minute, updated_by, origin)
    values ('20000000-0000-0000-0000-0000000000a2', '70000000-0000-0000-0000-000000000001',
            'c0000000-0000-0000-0000-0000000000aa', 15, 15, 0, 127, 0, 0, 'x', 'cloud')$$,
  '23503', null, 'una regla no puede apuntar a un perfil de otra instalacion');

insert into public.holders (id, installation_id, kind, name, deleted_at, updated_by, origin)
values ('30000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-00000000000a', 'persona', 'Borrado',
        now(), 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select throws_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 4321, '30000000-0000-0000-0000-0000000000d1', 'x', 'cloud')$$,
  '23503', null, 'no se puede dar de alta una tarjeta viva de un titular borrado');

-- ---------------------------------------------------------------------------
-- Borrado lógico en cascada (escritura del servidor con origin de panel)
-- ---------------------------------------------------------------------------
insert into public.holders (id, installation_id, kind, name, updated_by, origin)
values ('30000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-00000000000a', 'persona', 'Cascada',
        'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.cards (id, installation_id, card_code, holder_id, updated_by, origin) values
  ('40000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-00000000000a', 7001, '30000000-0000-0000-0000-0000000000c1', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001'),
  ('40000000-0000-0000-0000-0000000000c2', '20000000-0000-0000-0000-00000000000a', 7002, '30000000-0000-0000-0000-0000000000c1', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.controls (id, installation_id, holder_id, updated_by, origin)
values ('50000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-0000000000c1', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_by, origin) values
  ('60000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-0000000000c1', 0, 8001, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001'),
  ('60000000-0000-0000-0000-0000000000c2', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-0000000000c1', 1, 8002, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.holder_profiles (id, installation_id, holder_id, profile_id, updated_by, origin)
values ('80000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-0000000000c1', '70000000-0000-0000-0000-000000000001', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');

create temp table rev_antes as
  select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a';

update public.holders
set deleted_at = '2026-10-26 12:00:00+00', updated_at = '2026-10-26 12:00:00+00',
    updated_by = 'panel:PNL-TEST-0002', origin = 'panel:PNL-TEST-0002'
where id = '30000000-0000-0000-0000-0000000000c1';

create temp view cascada as
  select 'holders' as t, id, revision, deleted_at, updated_at, updated_by, origin from public.holders
    where id = '30000000-0000-0000-0000-0000000000c1'
  union all select 'cards', id, revision, deleted_at, updated_at, updated_by, origin from public.cards
    where id in ('40000000-0000-0000-0000-0000000000c1', '40000000-0000-0000-0000-0000000000c2')
  union all select 'controls', id, revision, deleted_at, updated_at, updated_by, origin from public.controls
    where id = '50000000-0000-0000-0000-0000000000c1'
  union all select 'control_buttons', id, revision, deleted_at, updated_at, updated_by, origin from public.control_buttons
    where id in ('60000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-0000000000c2')
  union all select 'holder_profiles', id, revision, deleted_at, updated_at, updated_by, origin from public.holder_profiles
    where id = '80000000-0000-0000-0000-0000000000c1';

select is(
  (select count(*)::int from cascada where t in ('cards', 'controls', 'control_buttons') and deleted_at is not null),
  5, 'borrar un titular deja sus 2 tarjetas, su control y sus 2 botones con deleted_at');
select is(
  (select count(*)::int from cascada where t = 'holder_profiles' and deleted_at is not null),
  1, 'borrar un titular tambien borra sus holder_profiles');
select is(
  (select count(distinct revision)::int from cascada where revision > (select revision from rev_antes)),
  7, 'el titular y cada uno de sus 6 hijos reciben su propia revision');
select is(
  (select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a')
    - (select revision from rev_antes),
  7::bigint, 'la instalacion sube una revision por cada fila borrada');
select is(
  (select count(*)::int from cascada
   where t <> 'holders'
     and deleted_at = '2026-10-26 12:00:00+00' and updated_at = '2026-10-26 12:00:00+00'
     and updated_by = 'panel:PNL-TEST-0002' and origin = 'panel:PNL-TEST-0002'),
  6, 'los hijos heredan deleted_at, updated_at, updated_by y origin del padre');
select is(
  (select count(*)::int from public.audit_log a join cascada c on c.id = a.row_id
   where a.op = 'delete' and a.updated_by = 'panel:PNL-TEST-0002' and a.table_name = c.t),
  7, 'audit_log registra el borrado del titular y de cada hijo');
select is(
  (select count(*)::int from (
     select id from public.cards where id = '40000000-0000-0000-0000-000000000002' and deleted_at is null
     union all select id from public.controls where id = '50000000-0000-0000-0000-000000000001' and deleted_at is null
     union all select id from public.control_buttons where id = '60000000-0000-0000-0000-000000000001' and deleted_at is null) x),
  3, 'la cascada no toca registros de otros titulares');

-- Perfil borrado: borra sus holder_profiles y sus reglas
insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_by, origin)
values ('70000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-00000000000a', 'Visitas', 1,
        'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.holder_profiles (id, installation_id, holder_id, profile_id, updated_by, origin)
values ('80000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000003', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.profile_panel_rules (id, installation_id, profile_id, panel_id, output_mask, card_reader_mask,
    pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute, updated_by, origin) values
  ('90000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-000000000003',
   'c0000000-0000-0000-0000-0000000000aa', 15, 15, 0, true, 127, 0, 0, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001'),
  ('90000000-0000-0000-0000-000000000032', '20000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-000000000003',
   'c0000000-0000-0000-0000-0000000000bb', 0, 0, 15, false, 31, 480, 1200, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select throws_ok(
  $$insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
      pin_reader_mask, weekday_mask, start_minute, end_minute, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-0000000000aa', 1, 1, 0, 1, 0, 0, 'x', 'cloud')$$,
  '23505', null, 'una sola regla viva por perfil y panel');
update public.access_profiles set deleted_at = now(), updated_by = 'panel:PNL-TEST-0003', origin = 'panel:PNL-TEST-0003'
where id = '70000000-0000-0000-0000-000000000003';
select is(
  (select count(*)::int from (
     select id from public.holder_profiles where id = '80000000-0000-0000-0000-000000000003'
       and deleted_at is not null and origin = 'panel:PNL-TEST-0003'
     union all select id from public.profile_panel_rules where profile_id = '70000000-0000-0000-0000-000000000003'
       and deleted_at is not null and origin = 'panel:PNL-TEST-0003') x),
  3, 'borrar un perfil borra sus holder_profiles y sus reglas por panel');

-- Salidas de un panel
insert into public.outputs (id, installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled, updated_by, origin)
values ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a',
        'c0000000-0000-0000-0000-0000000000aa', 0, 'Pluma vehicular', 3000, 3, true, 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
select throws_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000aa', 0, 3000, 3, true, 'x', 'cloud')$$,
  '23505', null, 'una sola salida viva por panel e indice');

-- Titular para la cascada hecha por un usuario
insert into public.holders (id, installation_id, kind, name, updated_by, origin)
values ('30000000-0000-0000-0000-0000000000e1', '20000000-0000-0000-0000-00000000000a', 'persona', 'Borrar desde la nube',
        'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');
insert into public.cards (id, installation_id, card_code, holder_id, updated_by, origin)
values ('40000000-0000-0000-0000-0000000000e1', '20000000-0000-0000-0000-00000000000a', 9001,
        '30000000-0000-0000-0000-0000000000e1', 'panel:PNL-TEST-0001', 'panel:PNL-TEST-0001');

-- ---------------------------------------------------------------------------
-- Usuario autenticado, miembro (admin) del tenant A
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

-- Riesgo 4: datos cruzados entre tenants
select is((select count(*)::int from public.holders where installation_id = '20000000-0000-0000-0000-00000000000b'), 0,
  'miembro de A ve 0 titulares de B');
select is((select count(*)::int from public.cards where installation_id = '20000000-0000-0000-0000-00000000000b'), 0,
  'miembro de A ve 0 tarjetas de B');
select is((select count(*)::int from public.holders where tenant_id <> '10000000-0000-0000-0000-00000000000a'), 0,
  'miembro de A no ve titulares de otros tenants');
select ok((select count(*) from public.holders) > 0, 'miembro de A si ve los titulares de A');
select is((select count(*)::int from public.audit_log where tenant_id <> '10000000-0000-0000-0000-00000000000a'), 0,
  'miembro de A no ve la auditoria de otros tenants');
select ok((select count(*) from public.audit_log) > 0, 'miembro de A ve la auditoria de A');
select throws_ok(
  $$insert into public.holders (installation_id, kind, name) values ('20000000-0000-0000-0000-00000000000b', 'persona', 'Intruso')$$,
  '42501', null, 'miembro de A no puede insertar con installation_id de B');
select is_empty(
  $$update public.cards set description = 'x' where id = '40000000-0000-0000-0000-0000000000b1' returning id$$,
  'miembro de A no modifica tarjetas de B');

-- Edición desde la interfaz
select lives_ok(
  $$insert into public.holders (installation_id, kind, name) values ('20000000-0000-0000-0000-00000000000a', 'persona', 'Creado en la nube')$$,
  'miembro de A da de alta un titular en su instalacion');
select results_eq(
  $$select origin, updated_by, updated_at = now() from public.holders where name = 'Creado en la nube'$$,
  $$values ('cloud'::text, 'user:00000000-0000-0000-0000-0000000000a1'::text, true)$$,
  'un alta como usuario deja origin=cloud, updated_by=user:<uid> y updated_at=now()');
update public.holders set notes = 'editado en la nube' where id = '30000000-0000-0000-0000-000000000001';
select results_eq(
  $$select origin, updated_by from public.holders where id = '30000000-0000-0000-0000-000000000001'$$,
  $$values ('cloud'::text, 'user:00000000-0000-0000-0000-0000000000a1'::text)$$,
  'una edicion como usuario autenticado deja origin=cloud y updated_by=user:<uid>');
select is(
  (select revision from public.holders where id = '30000000-0000-0000-0000-000000000001'),
  (select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a'),
  'la edicion del usuario toma la revision actual de la instalacion');

-- Columnas que solo pone el trigger
select throws_ok(
  $$insert into public.holders (installation_id, kind, name, origin) values ('20000000-0000-0000-0000-00000000000a', 'persona', 'X', 'panel:PNL-FAKE')$$,
  '42501', null, 'authenticated no puede escribir origin');
select throws_ok(
  $$update public.holders set revision = 999 where id = '30000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'authenticated no puede escribir revision');
select throws_ok(
  $$update public.holders set updated_by = 'user:otro' where id = '30000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'authenticated no puede escribir updated_by');
select throws_ok(
  $$update public.cards set tenant_id = '10000000-0000-0000-0000-00000000000b' where id = '40000000-0000-0000-0000-000000000002'$$,
  '42501', null, 'authenticated no puede escribir tenant_id');
select throws_ok(
  $$update public.cards set installation_id = '20000000-0000-0000-0000-0000000000a2' where id = '40000000-0000-0000-0000-000000000002'$$,
  '42501', null, 'authenticated no puede mover una fila de instalacion');
select throws_ok(
  $$delete from public.cards where id = '40000000-0000-0000-0000-000000000002'$$,
  '42501', null, 'authenticated no puede borrar fisicamente (el borrado es logico)');
select throws_ok(
  $$insert into public.audit_log (tenant_id, table_name, row_id, op, updated_by)
    values ('10000000-0000-0000-0000-00000000000a', 'holders', '30000000-0000-0000-0000-000000000001', 'update', 'falso')$$,
  '42501', null, 'authenticated no puede escribir en audit_log');

-- PIN: nunca legible por authenticated; has_pin sí
select throws_ok($$select pin_ciphertext from public.holders$$, '42501', null,
  'authenticated no puede leer pin_ciphertext');
select throws_ok($$select pin_lookup from public.holders$$, '42501', null,
  'authenticated no puede leer pin_lookup');
select results_eq(
  $$select has_pin from public.holders where id in ('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002') order by id$$,
  $$values (true), (false)$$,
  'has_pin refleja si el titular tiene PIN');
select lives_ok(
  $$insert into public.holders (installation_id, kind, name, pin_ciphertext, pin_lookup)
    values ('20000000-0000-0000-0000-00000000000a', 'persona', 'Con PIN', 'cifrado-2', 'lookup-2')$$,
  'authenticated si puede escribir el PIN cifrado y su pin_lookup');

-- Cascada hecha por un usuario: los hijos llevan el mismo autor que el padre
update public.holders set deleted_at = now() where id = '30000000-0000-0000-0000-0000000000e1';
select results_eq(
  $$select deleted_at = now(), updated_by, origin from public.cards where id = '40000000-0000-0000-0000-0000000000e1'$$,
  $$values (true, 'user:00000000-0000-0000-0000-0000000000a1'::text, 'cloud'::text)$$,
  'la cascada de un usuario deja updated_by=user:<uid> y origin=cloud en los hijos');
select is(
  (select count(*)::int from public.audit_log
   where row_id in ('30000000-0000-0000-0000-0000000000e1', '40000000-0000-0000-0000-0000000000e1')
     and op = 'delete' and updated_by = 'user:00000000-0000-0000-0000-0000000000a1'),
  2, 'audit_log registra quien borro el titular y su tarjeta');

-- Técnico del tenant A también edita datos
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
update public.cards set description = 'por tecnico' where id = '40000000-0000-0000-0000-000000000002';
select results_eq(
  $$select description, updated_by from public.cards where id = '40000000-0000-0000-0000-000000000002'$$,
  $$values ('por tecnico'::text, 'user:00000000-0000-0000-0000-0000000000a2'::text)$$,
  'un tecnico puede editar datos de su tenant');

-- Miembro de B no ve datos de A
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.holders where tenant_id = '10000000-0000-0000-0000-00000000000a'), 0,
  'miembro de B ve 0 titulares de A');
reset role;

-- ---------------------------------------------------------------------------
-- anon y service_role
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$select id from public.holders$$, '42501', null, 'anon no puede leer holders');
select throws_ok($$select id from public.audit_log$$, '42501', null, 'anon no puede leer audit_log');
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is((select pin_ciphertext from public.holders where id = '30000000-0000-0000-0000-000000000001'), 'cifrado-1',
  'service_role si lee el PIN cifrado');
select lives_ok($$delete from public.cards where id = '40000000-0000-0000-0000-000000000003'$$,
  'service_role puede borrar fisicamente');
reset role;

select * from finish();
rollback;
