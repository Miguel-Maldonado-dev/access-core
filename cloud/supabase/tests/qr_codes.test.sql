-- Pruebas de los códigos QR en la nube: qr_codes, ajustes de QR de la instalación,
-- profile_panel_rules.qr_reader_mask, tope, rango y limpieza. Corren con `supabase test db`.
-- Como postgres, auth.uid() es nulo: equivale a una escritura del servidor (llave secreta).
begin;
select plan(51);

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
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A');
insert into public.panels (id, panel_code, claim_code_hash, panel_secret_hash, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('1', 64), repeat('2', 64), 'pending');
select public.claim_panel('c0000000-0000-0000-0000-00000000000a', repeat('1', 64),
                          '20000000-0000-0000-0000-00000000000a');
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'x', 'cloud'),
  ('30000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000a', 'persona', 'Beto', 'x', 'cloud');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.qr_codes'::regclass), 'RLS activa en qr_codes');
select fk_ok('public', 'qr_codes', array['installation_id', 'holder_id'],
  'public', 'holders', array['installation_id', 'id'], 'qr_codes apunta a titulares de su instalación');
select has_index('public', 'qr_codes', 'qr_codes_installation_id_holder_id_idx', array['installation_id', 'holder_id'],
  'índice de la FK hacia holders');
select is((select (qr_digit, qr_max_active)::text from public.installations
            where id = '20000000-0000-0000-0000-00000000000a'), '(9,1000)',
  'la instalación nace con dígito 9 y tope 1000');
select col_default_is('public', 'profile_panel_rules', 'qr_reader_mask', '0', 'qr_reader_mask vale 0 por omisión');
select ok(has_column_privilege('authenticated', 'public.profile_panel_rules', 'qr_reader_mask', 'INSERT')
          and has_column_privilege('authenticated', 'public.profile_panel_rules', 'qr_reader_mask', 'UPDATE'),
  'authenticated crea y edita qr_reader_mask (como card_reader_mask)');
select ok(not has_column_privilege('authenticated', 'public.installations', 'qr_digit', 'UPDATE'),
  'authenticated no edita qr_digit directamente');
select is(private.qr_range(9)::text, '(900000000,999999999)', 'rango de D = 9');
select is(private.qr_range(4)::text, '(4000000000,4294967295)', 'rango de D = 4');
select is(private.qr_range(2)::text, '(2000000000,2999999999)', 'rango de D = 2');

-- ---------------------------------------------------------------------------
-- Código único vivo y vigencia
-- ---------------------------------------------------------------------------
insert into public.qr_codes (id, installation_id, holder_id, code, label, valid_from, valid_until, updated_by, origin)
values ('70000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-00000000000a', 912345678, 'Visita', now(), now() + interval '1 day', 'x', 'cloud');
select is((select max_uses from public.qr_codes where id = '70000000-0000-0000-0000-00000000000a'), 1,
  'max_uses vale 1 por omisión');
select is((select extract(microseconds from valid_from)::bigint % 1000000 from public.qr_codes
            where id = '70000000-0000-0000-0000-00000000000a'), 0::bigint,
  'las fechas se guardan truncadas a segundos');
select throws_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 912345678,
            now(), now() + interval '1 day', 'x', 'cloud')$$,
  '23505', null, 'el código es único entre los QR vivos');
select throws_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 912345679,
            now(), now(), 'x', 'cloud')$$,
  '23514', null, 'valid_until debe ser posterior a valid_from');
select throws_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, max_uses, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 912345679,
            now(), now() + interval '1 day', 101, 'x', 'cloud')$$,
  '23514', null, 'max_uses va de 1 a 100');

update public.qr_codes set deleted_at = now(), updated_by = 'x' where id = '70000000-0000-0000-0000-00000000000a';
select is((select label from public.qr_codes where id = '70000000-0000-0000-0000-00000000000a'), '',
  'borrar un QR vacía su etiqueta');
select lives_ok(
  $$insert into public.qr_codes (id, installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
    values ('70000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000a',
            '30000000-0000-0000-0000-00000000000b', 912345678, now(), now() + interval '1 day', 'x', 'cloud')$$,
  'tras borrar el primero, el código se puede volver a usar');

-- ---------------------------------------------------------------------------
-- Tope de QR vigentes
-- ---------------------------------------------------------------------------
select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 9, 2);
-- Uno vencido no cuenta.
insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 911111111,
        now() - interval '3 days', now() - interval '2 days', 'x', 'cloud');
select lives_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 922222222,
            now(), now() + interval '1 day', 'x', 'cloud')$$,
  'el segundo vigente cabe en el tope de 2 (el vencido no cuenta)');
select throws_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 933333333,
            now(), now() + interval '1 day', 'x', 'cloud')$$,
  'PT422', 'Se alcanzó el máximo de QR vigentes de la instalación.', 'el tercero vigente excede el tope');
select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 9, 1000);

-- ---------------------------------------------------------------------------
-- Tarjetas y rango de QR
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 955555555, '30000000-0000-0000-0000-00000000000a', 'x', 'cloud')$$,
  'PT422', 'Ese código está reservado para QR.', 'una tarjeta en el rango de QR se rechaza');
insert into public.cards (id, installation_id, card_code, holder_id, updated_by, origin)
values ('40000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 512345678,
        '30000000-0000-0000-0000-00000000000a', 'x', 'cloud');
select throws_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', 512345678,
            now(), now() + interval '1 day', 'x', 'cloud')$$,
  '23505', null, 'un QR con el código de una tarjeta viva se rechaza');
select throws_ok(
  $$select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 5, 1000)$$,
  'PT422', 'Hay tarjetas en ese rango', 'no se cambia el dígito si hay tarjetas vivas en el rango nuevo');

-- Roles: el técnico no cambia los ajustes; el admin sí y sube la revisión.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $$select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 8, 1000)$$,
  '42501', null, 'el técnico no cambia los ajustes de QR');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok(
  $$select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 8, 500)$$,
  'el admin cambia los ajustes de QR');
reset role;
select is((select (qr_digit, qr_max_active, qr_settings_revision = revision)::text from public.installations
            where id = '20000000-0000-0000-0000-00000000000a'), '(8,500,t)',
  'los ajustes cambian y qr_settings_revision toma la revisión nueva');
select lives_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 955555555, '30000000-0000-0000-0000-00000000000a', 'x', 'cloud')$$,
  'con D = 8 una tarjeta del rango 9 ya se acepta');
select throws_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', 912345678, '30000000-0000-0000-0000-00000000000a', 'x', 'cloud')$$,
  'PT422', 'Ese código está reservado para QR.', 'una tarjeta con el código de un QR vivo de otro dígito se rechaza');
select throws_ok(
  $$update public.cards set card_code = 912345678, updated_by = 'x' where card_code = 955555555$$,
  'PT422', 'Ese código está reservado para QR.', 'cambiar una tarjeta al código de un QR vivo se rechaza');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok(
  $$select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 7, 1000)$$,
  '42501', null, 'el admin de otro tenant no cambia los ajustes de QR');
reset role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.qr_codes), 0, 'otro tenant no ve los QR');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select lives_ok(
  $$insert into public.qr_codes (installation_id, holder_id, code, label, valid_from, valid_until, max_uses)
    values ('20000000-0000-0000-0000-00000000000a',
            '30000000-0000-0000-0000-00000000000a', 812345678, 'Paquetería', now(), now() + interval '1 day', 2)$$,
  'el técnico crea un QR');
select throws_ok(
  $$update public.qr_codes set label = 'Otro' where code = 812345678$$,
  '42501', null, 'el técnico no cambia la etiqueta (un QR no se edita)');
select lives_ok(
  $$update public.qr_codes set deleted_at = now() where code = 812345678$$,
  'el técnico revoca un QR');
reset role;
select ok((select deleted_at is not null and origin = 'cloud' from public.qr_codes
            where code = 812345678), 'el QR del técnico queda borrado');

-- ---------------------------------------------------------------------------
-- apply_panel_change
-- ---------------------------------------------------------------------------
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'qr-1', 'qr_codes', 'upsert',
    '70000000-0000-0000-0000-00000000000d', now(), false,
    '{"holder_id": "30000000-0000-0000-0000-00000000000a", "code": 887654321, "label": "Local",
      "valid_from": "2026-11-26T10:00:00.000Z", "valid_until": "2099-01-01T00:00:00.000Z", "max_uses": 3,
      "created_at": "2026-11-26T09:00:00.000Z"}', null) ->> 'status',
  'applied', 'el panel da de alta un QR');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'qr-2', 'qr_codes', 'upsert',
    '70000000-0000-0000-0000-00000000000e', now(), false,
    '{"holder_id": "30000000-0000-0000-0000-00000000000a", "code": 887654321, "label": "",
      "valid_from": "2026-11-26T10:00:00.000Z", "valid_until": "2099-01-01T00:00:00.000Z", "max_uses": 1,
      "created_at": "2026-11-26T09:00:00.000Z"}', null) ->> 'reason',
  'duplicado', 'un código repetido desde el panel se rechaza como duplicado');
-- Como servidor: sin claims, auth.uid() es nulo.
reset request.jwt.claims;
select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 8, 1);
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'qr-3', 'qr_codes', 'upsert',
    '70000000-0000-0000-0000-00000000000f', now(), false,
    '{"holder_id": "30000000-0000-0000-0000-00000000000a", "code": 866666666, "label": "",
      "valid_from": "2026-11-26T10:00:00.000Z", "valid_until": "2099-01-01T00:00:00.000Z", "max_uses": 1,
      "created_at": "2026-11-26T09:00:00.000Z"}', null) ->> 'status',
  'rejected', 'un QR del panel que excede el tope se rechaza');
select ok(exists (select 1 from public.sync_conflicts where row_id = '70000000-0000-0000-0000-00000000000f'
                    and resolution like '%máximo de QR vigentes%'),
  'el QR que excede el tope queda como conflicto');
select public.set_installation_qr_settings('20000000-0000-0000-0000-00000000000a', 8, 1000);
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'qrs-1', 'qr_settings', 'upsert',
    '20000000-0000-0000-0000-00000000000a', now(), false, '{"digit": 3, "max_active": 10}', null) ->> 'status',
  'superseded', 'qr_settings del panel nunca se aplica');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'card-r', 'cards', 'upsert',
    '40000000-0000-0000-0000-00000000000f', now(), false,
    '{"card_code": 812345670, "holder_id": "30000000-0000-0000-0000-00000000000a", "description": ""}', null)
    ->> 'status',
  'rejected', 'una tarjeta del panel en el rango de QR queda rechazada');
select ok(exists (select 1 from public.sync_conflicts where row_id = '40000000-0000-0000-0000-00000000000f'),
  'y queda como conflicto');

-- push_permission sin qr_reader_mask conserva el de la nube.
insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_at, updated_by, origin)
values ('60000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'Residentes', 1,
        now() - interval '1 day', 'x', 'cloud');
insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
  pin_reader_mask, qr_reader_mask, weekday_mask, start_minute, end_minute, updated_at, updated_by, origin)
values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-00000000000a',
        'c0000000-0000-0000-0000-00000000000a', 1, 1, 1, 5, 127, 0, 1439, now() - interval '1 day', 'x', 'cloud');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'perm-1', 'permissions', 'upsert',
    '60000000-0000-0000-0000-00000000000a', now() + interval '5 minutes', false,
    '{"permission_id": 1, "name": "Residentes", "output_mask": 3, "card_reader_mask": 1, "pin_reader_mask": 1,
      "allow_rf": false, "weekday_mask": 127, "start_minute": 0, "end_minute": 1439}', null) ->> 'status',
  'applied', 'un panel v8 actualiza la regla');
select is((select qr_reader_mask from public.profile_panel_rules where profile_id = '60000000-0000-0000-0000-00000000000a'),
  5, 'push_permission sin qr_reader_mask conserva el valor');

-- ---------------------------------------------------------------------------
-- Cascada del titular, vencimiento y purga
-- ---------------------------------------------------------------------------
update public.holders set deleted_at = now(), updated_by = 'x' where id = '30000000-0000-0000-0000-00000000000a';
select is((select count(*)::int from public.qr_codes
            where holder_id = '30000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'borrar el titular borra lógicamente sus QR');

insert into public.qr_codes (id, installation_id, holder_id, code, valid_from, valid_until, updated_by, origin)
values ('70000000-0000-0000-0000-0000000000f1', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-00000000000b', 844444444, now() - interval '40 days', now() - interval '31 days', 'x', 'cloud'),
       ('70000000-0000-0000-0000-0000000000f2', '20000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-00000000000b', 855555555, now() - interval '40 days', now() - interval '29 days', 'x', 'cloud');
select ok(private.expire_qr_codes() >= 1, 'expire_qr_codes borra QR');
select is((select string_agg((deleted_at is not null)::text, ',' order by id) from public.qr_codes
            where id in ('70000000-0000-0000-0000-0000000000f1', '70000000-0000-0000-0000-0000000000f2')),
  'true,false', 'expire_qr_codes borra solo los vencidos hace más de 30 días');
update public.qr_codes set deleted_at = now() - interval '40 days' where id = '70000000-0000-0000-0000-0000000000f1';
select ok(private.purge_deleted_rows(30) >= 1, 'la purga elimina filas');
select ok(not exists (select 1 from public.qr_codes where id = '70000000-0000-0000-0000-0000000000f1')
          and exists (select 1 from public.purged_rows where id = '70000000-0000-0000-0000-0000000000f1'
                      and table_name = 'qr_codes'),
  'purge_deleted_rows elimina el QR y deja su lápida');
select ok(exists (select 1 from cron.job where jobname = 'qr-codes-expire' and schedule = '50 8 * * *'),
  'trabajo diario qr-codes-expire');

select ok(public.delete_installation('20000000-0000-0000-0000-00000000000a'), 'la instalación se elimina');
select ok(not exists (select 1 from public.qr_codes)
          and not exists (select 1 from public.audit_log where table_name = 'qr_codes'),
  'eliminar la instalación borra los QR y su auditoría');

select * from finish();
rollback;
