-- Pruebas de public.delete_installation: borra físicamente todo lo de una instalación y sus
-- paneles, y nada de otra. Corren con `supabase test db`.
begin;
select plan(12);

select ok(not has_function_privilege('authenticated', 'public.delete_installation(uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.delete_installation(uuid)', 'EXECUTE'),
  'authenticated y anon no ejecutan delete_installation');
select ok(has_function_privilege('service_role', 'public.delete_installation(uuid)', 'EXECUTE'),
  'service_role ejecuta delete_installation');

-- Tenant con dos instalaciones: X (se elimina) y Y (se conserva).
insert into public.tenants (id, name) values ('12000000-0000-0000-0000-00000000000a', 'Tenant D');
insert into public.installations (id, tenant_id, name) values
  ('22000000-0000-0000-0000-00000000000a', '12000000-0000-0000-0000-00000000000a', 'Fracc X'),
  ('22000000-0000-0000-0000-00000000000b', '12000000-0000-0000-0000-00000000000a', 'Fracc Y');
-- A: activo en X. B: activo en Y (después se revoca y se reclama en X). C: activo en Y.
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c2000000-0000-0000-0000-00000000000a', 'PNL-DDDD-000A', repeat('2', 64), repeat('3', 64),
   '22000000-0000-0000-0000-00000000000a', 'active'),
  ('c2000000-0000-0000-0000-00000000000b', 'PNL-DDDD-000B', repeat('4', 64), repeat('5', 64),
   '22000000-0000-0000-0000-00000000000b', 'active'),
  ('c2000000-0000-0000-0000-00000000000c', 'PNL-DDDD-000C', repeat('6', 64), repeat('7', 64),
   '22000000-0000-0000-0000-00000000000b', 'active');

-- Datos de las dos instalaciones (misma forma).
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('32000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'prueba', 'cloud'),
  ('32000000-0000-0000-0000-00000000000b', '22000000-0000-0000-0000-00000000000b', 'persona', 'Beto', 'prueba', 'cloud');
insert into public.cards (installation_id, holder_id, card_code, updated_by, origin) values
  ('22000000-0000-0000-0000-00000000000a', '32000000-0000-0000-0000-00000000000a', 111, 'prueba', 'cloud'),
  ('22000000-0000-0000-0000-00000000000b', '32000000-0000-0000-0000-00000000000b', 222, 'prueba', 'cloud');
insert into public.controls (id, installation_id, holder_id, updated_by, origin) values
  ('52000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   '32000000-0000-0000-0000-00000000000a', 'prueba', 'cloud'),
  ('52000000-0000-0000-0000-00000000000b', '22000000-0000-0000-0000-00000000000b',
   '32000000-0000-0000-0000-00000000000b', 'prueba', 'cloud');
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_by, origin) values
  ('62000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   '52000000-0000-0000-0000-00000000000a', 0, 1234, 'prueba', 'cloud'),
  ('62000000-0000-0000-0000-00000000000b', '22000000-0000-0000-0000-00000000000b',
   '52000000-0000-0000-0000-00000000000b', 0, 5678, 'prueba', 'cloud');
insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_by, origin) values
  ('42000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', 'Perfil', 1, 'prueba', 'cloud'),
  ('42000000-0000-0000-0000-00000000000b', '22000000-0000-0000-0000-00000000000b', 'Perfil', 1, 'prueba', 'cloud');
insert into public.holder_profiles (installation_id, holder_id, profile_id, updated_by, origin) values
  ('22000000-0000-0000-0000-00000000000a', '32000000-0000-0000-0000-00000000000a',
   '42000000-0000-0000-0000-00000000000a', 'prueba', 'cloud'),
  ('22000000-0000-0000-0000-00000000000b', '32000000-0000-0000-0000-00000000000b',
   '42000000-0000-0000-0000-00000000000b', 'prueba', 'cloud');

-- Filas por panel: A en X; B y C en Y.
insert into public.outputs (installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled,
                            updated_by, origin)
select inst, p, 0, 'Salida', 3000, 1, true, 'prueba', 'cloud'
from (values ('22000000-0000-0000-0000-00000000000a'::uuid, 'c2000000-0000-0000-0000-00000000000a'::uuid),
             ('22000000-0000-0000-0000-00000000000b', 'c2000000-0000-0000-0000-00000000000b'),
             ('22000000-0000-0000-0000-00000000000b', 'c2000000-0000-0000-0000-00000000000c')) v(inst, p);
insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
                                        pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute,
                                        updated_by, origin)
select inst, prof, p, 15, 15, 0, true, 127, 0, 0, 'prueba', 'cloud'
from (values ('22000000-0000-0000-0000-00000000000a'::uuid, '42000000-0000-0000-0000-00000000000a'::uuid,
              'c2000000-0000-0000-0000-00000000000a'::uuid),
             ('22000000-0000-0000-0000-00000000000b', '42000000-0000-0000-0000-00000000000b',
              'c2000000-0000-0000-0000-00000000000b'),
             ('22000000-0000-0000-0000-00000000000b', '42000000-0000-0000-0000-00000000000b',
              'c2000000-0000-0000-0000-00000000000c')) v(inst, prof, p);
insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
select inst, b, p, 0, 'prueba', 'cloud'
from (values ('22000000-0000-0000-0000-00000000000a'::uuid, '62000000-0000-0000-0000-00000000000a'::uuid,
              'c2000000-0000-0000-0000-00000000000a'::uuid),
             ('22000000-0000-0000-0000-00000000000b', '62000000-0000-0000-0000-00000000000b',
              'c2000000-0000-0000-0000-00000000000b'),
             ('22000000-0000-0000-0000-00000000000b', '62000000-0000-0000-0000-00000000000b',
              'c2000000-0000-0000-0000-00000000000c')) v(inst, b, p);

insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
values ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
        'c2000000-0000-0000-0000-00000000000a', 'test_output', 0, 'x', now() + interval '10 seconds'),
       ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000b',
        'c2000000-0000-0000-0000-00000000000c', 'test_output', 0, 'x', now() + interval '10 seconds');
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason)
values ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
        'c2000000-0000-0000-0000-00000000000a', 1, now() - interval '1 minute', true, 0, 0),
       ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000b',
        'c2000000-0000-0000-0000-00000000000c', 1, now() - interval '1 minute', true, 0, 0);
select public.purge_installation_logs('22000000-0000-0000-0000-00000000000a', null, 'prueba');
insert into public.access_logs (tenant_id, installation_id, panel_id, local_log_id, ts, allowed, source, reason)
values ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
        'c2000000-0000-0000-0000-00000000000a', 2, now(), true, 0, 0);

-- B se revoca en Y (sus filas en Y quedan con borrado lógico) y se reclama en X.
select public.revoke_panel('c2000000-0000-0000-0000-00000000000b');
update public.panels set status = 'claimed', installation_id = '22000000-0000-0000-0000-00000000000a'
 where id = 'c2000000-0000-0000-0000-00000000000b';

create temp table y_before as
  select (select count(*) from public.audit_log a where a.row_id in
            (select id from public.holders where installation_id = '22000000-0000-0000-0000-00000000000b')) as audit_holders,
         (select revision from public.outputs where panel_id = 'c2000000-0000-0000-0000-00000000000b') as b_rev;

select ok(public.delete_installation('22000000-0000-0000-0000-00000000000a'), 'delete_installation devuelve true');
select ok(not public.delete_installation('22000000-0000-0000-0000-00000000000a'),
  'una instalación inexistente devuelve false');

select is((select count(*)::int from public.installations where id = '22000000-0000-0000-0000-00000000000a'), 0,
  'la instalación ya no existe');
select is((select count(*)::int from public.panels
           where id in ('c2000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000b')), 0,
  'sus paneles (activo y reclamado) se eliminan');

-- Ninguna tabla pública conserva filas de X.
select is(
  (select sum(n)::int from (
     select (xpath('/row/n/text()', query_to_xml(format(
       'select count(*) as n from public.%I where installation_id = %L', c.table_name,
       '22000000-0000-0000-0000-00000000000a'), false, true, '')))[1]::text::int as n
     from information_schema.columns c
     where c.table_schema = 'public' and c.column_name = 'installation_id'
       and c.table_name in (select tablename from pg_tables where schemaname = 'public')) s),
  0, 'ninguna tabla conserva filas de la instalación');
select is((select count(*)::int from public.audit_log a
           where a.row_id in ('32000000-0000-0000-0000-00000000000a', '52000000-0000-0000-0000-00000000000a',
                              '62000000-0000-0000-0000-00000000000a', '42000000-0000-0000-0000-00000000000a')), 0,
  'su auditoría se elimina');

-- Y conserva todo lo suyo salvo las filas viejas de B.
select results_eq(
  $$select (select count(*)::int from public.holders where installation_id = '22000000-0000-0000-0000-00000000000b'),
           (select count(*)::int from public.cards where installation_id = '22000000-0000-0000-0000-00000000000b'),
           (select count(*)::int from public.control_buttons where installation_id = '22000000-0000-0000-0000-00000000000b'),
           (select count(*)::int from public.holder_profiles where installation_id = '22000000-0000-0000-0000-00000000000b'),
           (select count(*)::int from public.access_logs where installation_id = '22000000-0000-0000-0000-00000000000b'),
           (select count(*)::int from public.panel_commands where installation_id = '22000000-0000-0000-0000-00000000000b'),
           (select count(*)::int from public.outputs where panel_id = 'c2000000-0000-0000-0000-00000000000c'),
           (select count(*)::int from public.profile_panel_rules where panel_id = 'c2000000-0000-0000-0000-00000000000c'),
           (select count(*)::int from public.control_button_panels where panel_id = 'c2000000-0000-0000-0000-00000000000c'),
           (select status from public.panels where id = 'c2000000-0000-0000-0000-00000000000c')$$,
  $$values (1, 1, 1, 1, 1, 1, 1, 1, 1, 'active'::text)$$,
  'la otra instalación no se toca');
select is((select count(*)::int from public.audit_log a where a.row_id in
            (select id from public.holders where installation_id = '22000000-0000-0000-0000-00000000000b')),
          (select audit_holders::int from y_before),
  'la auditoría de la otra instalación se conserva');
select is((select count(*)::int from public.purged_rows
           where installation_id = '22000000-0000-0000-0000-00000000000b'), 3,
  'las filas viejas del panel reclamado en la otra instalación dejan lápida');
select ok((select purged_revision from public.installations where id = '22000000-0000-0000-0000-00000000000b')
          >= (select b_rev from y_before),
  'la otra instalación sube purged_revision');

select * from finish();
rollback;
