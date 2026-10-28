-- Pruebas de paneles, intentos de reclamo y FK de salidas y reglas hacia panels (N5).
-- Corren con `supabase test db` en el stack local. Como postgres, auth.uid() es nulo:
-- equivale a una escritura del servidor (llave secreta).
begin;
select plan(62);

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

-- Perfiles para las reglas por panel
insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_by, origin) values
  ('70000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'Residente', 0, 'x', 'cloud');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.panels'::regclass), 'RLS activa en panels');
select ok((select relrowsecurity from pg_class where oid = 'public.panel_claim_attempts'::regclass),
  'RLS activa en panel_claim_attempts');
select columns_are('public', 'panels',
  array['id', 'panel_code', 'claim_code_hash', 'panel_secret_hash', 'device_token_hash', 'installation_id',
        'tenant_id', 'status', 'online', 'last_seen_at', 'software_version', 'schema_version',
        'synced_revision', 'last_sync_at', 'sync_blocked', 'confirm_deletions_until', 'created_at', 'online_event_at'],
  'panels tiene exactamente las columnas del contrato');
select fk_ok('public', 'outputs', array['panel_id'], 'public', 'panels', array['id'],
  'outputs.panel_id es FK hacia panels(id)');
select fk_ok('public', 'profile_panel_rules', array['panel_id'], 'public', 'panels', array['id'],
  'profile_panel_rules.panel_id es FK hacia panels(id)');
select is(
  (select count(*)::int from pg_index i
   where i.indrelid = 'public.outputs'::regclass and i.indpred is null and i.indnkeyatts = 1
     and i.indkey[0] = (select attnum from pg_attribute
                        where attrelid = 'public.outputs'::regclass and attname = 'panel_id')),
  1, 'outputs tiene un indice no parcial sobre panel_id (para la FK)');
select is(
  (select count(*)::int from pg_index i
   where i.indrelid = 'public.profile_panel_rules'::regclass and i.indpred is null and i.indnkeyatts = 1
     and i.indkey[0] = (select attnum from pg_attribute
                        where attrelid = 'public.profile_panel_rules'::regclass and attname = 'panel_id')),
  1, 'profile_panel_rules tiene un indice no parcial sobre panel_id (para la FK)');

-- ---------------------------------------------------------------------------
-- Restricciones de panels (escrituras del servidor)
-- ---------------------------------------------------------------------------
-- P0: pendiente, sin instalación. PA: activo en IA. PA2: activo en IA2. PB: activo en IB.
insert into public.panels (id, panel_code, claim_code_hash, panel_secret_hash, status) values
  ('c0000000-0000-0000-0000-000000000000', 'PNL-0000-0000', repeat('1', 64), repeat('2', 64), 'pending');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('2', 64), repeat('3', 64),
   '20000000-0000-0000-0000-00000000000a', 'active'),
  ('c0000000-0000-0000-0000-0000000000a2', 'PNL-AAAA-00A2', repeat('2', 64), repeat('4', 64),
   '20000000-0000-0000-0000-0000000000a2', 'active'),
  ('c0000000-0000-0000-0000-00000000000b', 'PNL-BBBB-000B', repeat('2', 64), repeat('5', 64),
   '20000000-0000-0000-0000-00000000000b', 'active');

select results_eq(
  $$select status, online, synced_revision, installation_id, tenant_id from public.panels
    where id = 'c0000000-0000-0000-0000-000000000000'$$,
  $$values ('pending'::text, false, 0::bigint, null::uuid, null::uuid)$$,
  'un panel nuevo queda pending, fuera de linea, en la revision 0 y sin instalacion ni tenant');
select is((select tenant_id from public.panels where id = 'c0000000-0000-0000-0000-00000000000a'),
  '10000000-0000-0000-0000-00000000000a'::uuid, 'tenant_id lo pone el trigger desde la instalacion');
insert into public.panels (id, panel_code, panel_secret_hash, installation_id, tenant_id, status)
values ('c0000000-0000-0000-0000-0000000000c1', 'PNL-CCCC-00C1', repeat('2', 64),
        '20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000b', 'claimed');
select is((select tenant_id from public.panels where id = 'c0000000-0000-0000-0000-0000000000c1'),
  '10000000-0000-0000-0000-00000000000a'::uuid, 'un tenant_id ajeno a la instalacion se reemplaza');

select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('PNL-IIII-0001', repeat('2', 64), 'pending')$$,
  '23514', null, 'panel_code fuera del alfabeto Crockford se rechaza');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('pnl-aaaa-0001', repeat('2', 64), 'pending')$$,
  '23514', null, 'panel_code en minusculas se rechaza');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('PNL-AAAA-0001', repeat('2', 64), 'otro')$$,
  '23514', null, 'status fuera de la lista se rechaza');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('PNL-AAAA-0001', repeat('A', 64), 'pending')$$,
  '23514', null, 'un hash que no es sha256 hexadecimal en minusculas se rechaza');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('PNL-0000-0000', repeat('2', 64), 'pending')$$,
  '23505', null, 'panel_code es unico');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('PNL-AAAA-0001', repeat('2', 64), 'claimed')$$,
  '23514', null, 'un panel reclamado necesita instalacion');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, installation_id, status)
    values ('PNL-AAAA-0001', repeat('2', 64), '20000000-0000-0000-0000-00000000000a', 'pending')$$,
  '23514', null, 'un panel pendiente no tiene instalacion');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, device_token_hash, installation_id, status)
    values ('PNL-AAAA-0001', repeat('2', 64), repeat('3', 64), '20000000-0000-0000-0000-00000000000a', 'claimed')$$,
  '23514', null, 'solo staging, awaiting_review y active tienen credencial de dispositivo');
select throws_ok(
  $$insert into public.panels (panel_code, claim_code_hash, panel_secret_hash, installation_id, status)
    values ('PNL-AAAA-0001', repeat('1', 64), repeat('2', 64), '20000000-0000-0000-0000-00000000000a', 'active')$$,
  '23514', null, 'solo un panel pendiente guarda codigo de vinculacion');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, installation_id, status)
    values ('PNL-AAAA-0001', repeat('2', 64), '29999999-0000-0000-0000-000000000000', 'claimed')$$,
  '23503', null, 'una instalacion inexistente se rechaza');

-- ---------------------------------------------------------------------------
-- Salidas y reglas: el panel debe ser de la misma instalación
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into public.outputs (id, installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('a0000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 0, 3000, 1, true, 'x', 'cloud')$$,
  'una salida de un panel de la misma instalacion se acepta');
select throws_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000a2', 0, 3000, 1, true, 'x', 'cloud')$$,
  '23503', null, 'una salida no puede ser de un panel de otra instalacion del mismo tenant');
select throws_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000b', 0, 3000, 1, true, 'x', 'cloud')$$,
  '23503', null, 'una salida no puede ser de un panel de otro tenant');
select throws_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'c9999999-0000-0000-0000-000000000000', 1, 3000, 1, true, 'x', 'cloud')$$,
  '23503', null, 'una salida no puede ser de un panel inexistente');
select throws_ok(
  $$update public.outputs set panel_id = 'c0000000-0000-0000-0000-0000000000a2'
    where id = 'a0000000-0000-0000-0000-00000000000a'$$,
  '23503', null, 'una salida no puede pasarse a un panel de otra instalacion');
select lives_ok(
  $$insert into public.profile_panel_rules (id, installation_id, profile_id, panel_id, output_mask, card_reader_mask,
      pin_reader_mask, weekday_mask, start_minute, end_minute, updated_by, origin)
    values ('90000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            '70000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a', 1, 1, 0, 127, 0, 0, 'x', 'cloud')$$,
  'una regla de un panel de la misma instalacion se acepta');
select throws_ok(
  $$insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
      pin_reader_mask, weekday_mask, start_minute, end_minute, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-0000000000a2', 1, 1, 0, 127, 0, 0, 'x', 'cloud')$$,
  '23503', null, 'una regla no puede ser de un panel de otra instalacion');

-- ---------------------------------------------------------------------------
-- Revocar y volver a reclamar en otra instalación (PA pasa de IA a IB)
-- ---------------------------------------------------------------------------
update public.panels set status = 'revoked', device_token_hash = null
where id = 'c0000000-0000-0000-0000-00000000000a';
select is((select tenant_id from public.panels where id = 'c0000000-0000-0000-0000-00000000000a'),
  '10000000-0000-0000-0000-00000000000a'::uuid, 'un panel revocado conserva su instalacion y su tenant');
update public.panels set status = 'pending', installation_id = null, claim_code_hash = repeat('6', 64)
where id = 'c0000000-0000-0000-0000-00000000000a';
select is((select tenant_id from public.panels where id = 'c0000000-0000-0000-0000-00000000000a'),
  null::uuid, 'sin instalacion el panel queda sin tenant');
update public.panels set status = 'claimed', installation_id = '20000000-0000-0000-0000-00000000000b', claim_code_hash = null
where id = 'c0000000-0000-0000-0000-00000000000a';
select is((select tenant_id from public.panels where id = 'c0000000-0000-0000-0000-00000000000a'),
  '10000000-0000-0000-0000-00000000000b'::uuid, 'al reclamarse en otra instalacion el panel toma el tenant nuevo');

select lives_ok(
  $$update public.outputs set deleted_at = now(), updated_by = 'x', origin = 'cloud'
    where id = 'a0000000-0000-0000-0000-00000000000a'$$,
  'la salida vieja (de IA) se puede seguir actualizando aunque el panel ya este en IB');
select lives_ok(
  $$update public.profile_panel_rules set output_mask = 3, updated_by = 'x', origin = 'cloud'
    where id = '90000000-0000-0000-0000-00000000000a'$$,
  'la regla vieja (de IA) se puede seguir actualizando aunque el panel ya este en IB');
select throws_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a', 1, 3000, 1, true, 'x', 'cloud')$$,
  '23503', null, 'ya no se aceptan salidas nuevas de ese panel en la instalacion vieja');
select lives_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-00000000000a', 0, 3000, 1, true, 'x', 'cloud')$$,
  'se aceptan salidas de ese panel en la instalacion nueva');
select throws_ok(
  $$delete from public.panels where id = 'c0000000-0000-0000-0000-00000000000a'$$,
  '23503', null, 'no se puede borrar un panel con salidas o reglas');

-- ---------------------------------------------------------------------------
-- public.claim_panel: reclamo atómico y borrado lógico de lo de otra instalación
-- ---------------------------------------------------------------------------
-- PD y PE estuvieron en IA (con salida, y PD con regla); se revocaron y se registraron
-- de nuevo (pendientes, sin instalación). PD se reclama en IA2; PE vuelve a IA.
insert into public.panels (id, panel_code, panel_secret_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-0000000000d1', 'PNL-DDDD-00D1', repeat('2', 64), '20000000-0000-0000-0000-00000000000a', 'claimed'),
  ('c0000000-0000-0000-0000-0000000000e1', 'PNL-EEEE-00E1', repeat('2', 64), '20000000-0000-0000-0000-00000000000a', 'claimed');
insert into public.outputs (id, installation_id, panel_id, output_index, duration_ms, reader_mask, enabled, updated_by, origin) values
  ('a0000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000d1',
   0, 3000, 1, true, 'x', 'cloud'),
  ('a0000000-0000-0000-0000-0000000000e1', '20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000e1',
   0, 3000, 1, true, 'x', 'cloud');
insert into public.profile_panel_rules (id, installation_id, profile_id, panel_id, output_mask, card_reader_mask,
    pin_reader_mask, weekday_mask, start_minute, end_minute, updated_by, origin)
values ('90000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-00000000000a',
        '70000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000d1', 1, 1, 0, 127, 0, 0, 'x', 'cloud');
update public.panels set status = 'revoked'
where id in ('c0000000-0000-0000-0000-0000000000d1', 'c0000000-0000-0000-0000-0000000000e1');
update public.panels set status = 'pending', installation_id = null, claim_code_hash = repeat('7', 64)
where id in ('c0000000-0000-0000-0000-0000000000d1', 'c0000000-0000-0000-0000-0000000000e1');

select is(
  public.claim_panel('c0000000-0000-0000-0000-0000000000d1', repeat('8', 64),
                     '20000000-0000-0000-0000-0000000000a2'),
  null::jsonb, 'claim_panel con otro claim_code_hash no reclama');
select is((select status from public.panels where id = 'c0000000-0000-0000-0000-0000000000d1'), 'pending',
  'y el panel sigue pendiente');
select is(
  public.claim_panel('c0000000-0000-0000-0000-0000000000d1', repeat('7', 64),
                     '20000000-0000-0000-0000-0000000000a2'),
  jsonb_build_object('id', 'c0000000-0000-0000-0000-0000000000d1'::uuid, 'panel_code', 'PNL-DDDD-00D1',
                     'status', 'claimed', 'installation_id', '20000000-0000-0000-0000-0000000000a2'::uuid),
  'claim_panel reclama el panel en la instalacion nueva y lo devuelve');
select results_eq(
  $$select deleted_at is not null, updated_at = now(), updated_by, origin
    from public.outputs where id = 'a0000000-0000-0000-0000-0000000000d1'$$,
  $$values (true, true, 'system:reclamo'::text, 'cloud'::text)$$,
  'reclamar en otra instalacion borra logicamente la salida vieja como servidor, con autor neutro');
select results_eq(
  $$select deleted_at is not null, updated_at = now(), updated_by, origin
    from public.profile_panel_rules where id = '90000000-0000-0000-0000-0000000000d1'$$,
  $$values (true, true, 'system:reclamo'::text, 'cloud'::text)$$,
  'reclamar en otra instalacion borra logicamente la regla vieja como servidor, con autor neutro');
select is(
  (select count(*)::int from public.audit_log
   where row_id in ('a0000000-0000-0000-0000-0000000000d1', '90000000-0000-0000-0000-0000000000d1')
     and op = 'delete' and updated_by = 'system:reclamo'),
  2, 'audit_log registra ambos borrados con el autor neutro (sin el uid de quien reclama)');
select isnt(
  public.claim_panel('c0000000-0000-0000-0000-0000000000e1', repeat('7', 64),
                     '20000000-0000-0000-0000-00000000000a'),
  null::jsonb, 'PE se reclama de vuelta en IA');
select is((select deleted_at from public.outputs where id = 'a0000000-0000-0000-0000-0000000000e1'), null::timestamptz,
  'volver a la misma instalacion conserva sus salidas vivas');

-- ---------------------------------------------------------------------------
-- Usuario autenticado: admin del tenant A
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select results_eq(
  $$select id from public.panels order by id$$,
  $$values ('c0000000-0000-0000-0000-0000000000a2'::uuid), ('c0000000-0000-0000-0000-0000000000c1'::uuid),
           ('c0000000-0000-0000-0000-0000000000d1'::uuid), ('c0000000-0000-0000-0000-0000000000e1'::uuid)$$,
  'miembro de A ve solo los paneles de A (ni pendientes ni de B)');
select lives_ok(
  $$select id, panel_code, installation_id, tenant_id, status, online, last_seen_at, software_version,
           schema_version, synced_revision, last_sync_at, sync_blocked, confirm_deletions_until, created_at
    from public.panels$$,
  'miembro puede leer las columnas no secretas');
select throws_ok($$select claim_code_hash from public.panels$$, '42501', null,
  'authenticated no puede leer claim_code_hash');
select throws_ok($$select panel_secret_hash from public.panels$$, '42501', null,
  'authenticated no puede leer panel_secret_hash');
select throws_ok($$select device_token_hash from public.panels$$, '42501', null,
  'authenticated no puede leer device_token_hash');
select throws_ok(
  $$insert into public.panels (panel_code, panel_secret_hash, status) values ('PNL-AAAA-0009', repeat('2', 64), 'pending')$$,
  '42501', null, 'authenticated no puede crear paneles');
select throws_ok(
  $$update public.panels set status = 'revoked' where id = 'c0000000-0000-0000-0000-0000000000a2'$$,
  '42501', null, 'authenticated no puede modificar paneles');
select throws_ok(
  $$delete from public.panels where id = 'c0000000-0000-0000-0000-0000000000a2'$$,
  '42501', null, 'authenticated no puede borrar paneles');
select throws_ok($$select * from public.panel_claim_attempts$$, '42501', null,
  'authenticated no puede leer panel_claim_attempts');
select throws_ok(
  $$insert into public.panel_claim_attempts (tenant_id) values ('10000000-0000-0000-0000-00000000000a')$$,
  '42501', null, 'authenticated no puede escribir panel_claim_attempts');
select throws_ok(
  $$select public.claim_panel('c0000000-0000-0000-0000-000000000000', repeat('1', 64),
                              '20000000-0000-0000-0000-00000000000a')$$,
  '42501', null, 'authenticated no puede ejecutar claim_panel');

-- Desde la interfaz: la salida solo puede ser de un panel de la misma instalación
select lives_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled)
    values ('20000000-0000-0000-0000-0000000000a2', 'c0000000-0000-0000-0000-0000000000a2', 0, 3000, 1, true)$$,
  'miembro de A da de alta una salida de un panel de su instalacion');
select throws_ok(
  $$insert into public.outputs (installation_id, panel_id, output_index, duration_ms, reader_mask, enabled)
    values ('20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a', 2, 3000, 1, true)$$,
  '23503', null, 'miembro de A no puede dar de alta una salida de un panel que ahora es de B');

-- Admin del tenant B
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select results_eq(
  $$select id from public.panels order by id$$,
  $$values ('c0000000-0000-0000-0000-00000000000a'::uuid), ('c0000000-0000-0000-0000-00000000000b'::uuid)$$,
  'miembro de B ve sus paneles, incluido el que se reclamo desde A');
reset role;

-- ---------------------------------------------------------------------------
-- anon y service_role
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$select id from public.panels$$, '42501', null, 'anon no puede leer panels');
select throws_ok($$select id from public.panel_claim_attempts$$, '42501', null,
  'anon no puede leer panel_claim_attempts');
select throws_ok(
  $$select public.claim_panel('c0000000-0000-0000-0000-000000000000', repeat('1', 64),
                              '20000000-0000-0000-0000-00000000000a')$$,
  '42501', null, 'anon no puede ejecutar claim_panel');
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is((select panel_secret_hash from public.panels where id = 'c0000000-0000-0000-0000-000000000000'),
  repeat('2', 64), 'service_role si lee los hashes');
select lives_ok(
  $$insert into public.panel_claim_attempts (tenant_id) values ('10000000-0000-0000-0000-00000000000a')$$,
  'service_role registra intentos de reclamo');
reset role;

select * from finish();
rollback;
