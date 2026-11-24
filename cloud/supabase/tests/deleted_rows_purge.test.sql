-- Pruebas del borrado definitivo: vaciado al borrar (private.scrub_deleted_row) y
-- eliminación a los 30 días (private.purge_deleted_rows, trabajo deleted-rows-purge).
-- Corren con `supabase test db`. Como postgres, auth.uid() es nulo (escritura del servidor),
-- así que deleted_at se puede fechar en el pasado.
begin;
select plan(29);

select ok(not has_function_privilege('authenticated', 'private.purge_deleted_rows(int)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.purge_deleted_rows(int)', 'EXECUTE'),
  'authenticated y anon no ejecutan purge_deleted_rows');
select is((select schedule from cron.job where jobname = 'deleted-rows-purge'), '0 9 * * *',
  'el trabajo deleted-rows-purge corre a diario a las 9');

-- Datos base.
insert into public.tenants (id, name) values ('12000000-0000-0000-0000-00000000000a', 'Tenant P');
insert into public.installations (id, tenant_id, name) values
  ('22000000-0000-0000-0000-00000000000a', '12000000-0000-0000-0000-00000000000a', 'Fracc P');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c2000000-0000-0000-0000-00000000000a', 'PNL-PPPP-000A', repeat('2', 64), repeat('3', 64),
   '22000000-0000-0000-0000-00000000000a', 'active');
-- Panel revocado hace mucho, sin actividad reciente.
insert into public.panels (id, panel_code, panel_secret_hash, installation_id, status, last_seen_at, created_at) values
  ('c2000000-0000-0000-0000-00000000000b', 'PNL-PPPP-000B', repeat('4', 64),
   '22000000-0000-0000-0000-00000000000a', 'revoked', now() - interval '60 days', now() - interval '90 days');

insert into public.holders (id, installation_id, kind, name, department, address, notes, pin_ciphertext, pin_lookup,
                            updated_by, origin) values
  ('32000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'A1',
   'Calle 1', 'nota', 'cifrado', 'lookup-a', 'prueba', 'cloud'),
  ('32000000-0000-0000-0000-00000000000b', '22000000-0000-0000-0000-00000000000a', 'persona', 'Beto', '', '', '',
   null, null, 'prueba', 'cloud');
insert into public.cards (id, installation_id, card_code, holder_id, description, updated_by, origin) values
  ('42000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', 777,
   '32000000-0000-0000-0000-00000000000a', 'llavero', 'prueba', 'cloud');
insert into public.controls (id, installation_id, holder_id, description, updated_by, origin) values
  ('52000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   '32000000-0000-0000-0000-00000000000a', 'control de Ana', 'prueba', 'cloud');
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_by, origin) values
  ('62000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   '52000000-0000-0000-0000-00000000000a', 0, 4321, 'prueba', 'cloud');
insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
values ('22000000-0000-0000-0000-00000000000a', '62000000-0000-0000-0000-00000000000a',
        'c2000000-0000-0000-0000-00000000000a', 0, 'prueba', 'cloud');
insert into public.outputs (id, installation_id, panel_id, output_index, alias, duration_ms, reader_mask, enabled,
                            updated_by, origin) values
  ('72000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 0, 'Pluma', 3000, 1, true, 'prueba', 'cloud');

-- Conflictos previos con datos personales: uno de Ana (se vacía al borrar), uno revisado
-- viejo de otra fila y uno sin revisar reciente.
insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind,
                                   cloud_version, panel_version, resolution, created_at, reviewed_at) values
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'holders', '32000000-0000-0000-0000-00000000000a', 'lww',
   '{"name": "Ana"}', '{"name": "Ana P"}', 'x', now(), null),
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'outputs', '72000000-0000-0000-0000-0000000000ff', 'lww',
   '{"alias": "Vieja"}', null, 'revisado', now() - interval '40 days', now() - interval '35 days'),
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'outputs', '72000000-0000-0000-0000-0000000000fe', 'lww',
   '{"alias": "Nueva"}', null, 'sin revisar', now() - interval '40 days', null);
-- Importación vieja de un panel que ya no espera revisión (el revocado).
insert into public.panel_imports (panel_id, snapshot, diff, created_at) values
  ('c2000000-0000-0000-0000-00000000000b', '{"holders": [{"data": {"name": "Ana"}}]}', '{}', now() - interval '40 days');

-- 1. Vaciado al borrar (el borrado del titular baja en cascada).
update public.holders
   set deleted_at = now() - interval '31 days', updated_at = now(), updated_by = 'prueba', origin = 'cloud'
 where id = '32000000-0000-0000-0000-00000000000a';

select results_eq(
  $$select name, department, address, notes, pin_ciphertext, pin_lookup, has_pin
      from public.holders where id = '32000000-0000-0000-0000-00000000000a'$$,
  $$values ('(borrado)'::text, ''::text, ''::text, ''::text, null::text, null::text, false)$$,
  'el titular borrado pierde nombre, departamento, dirección, notas y PIN');
select results_eq(
  $$select card_code, description, deleted_at is not null from public.cards
     where id = '42000000-0000-0000-0000-00000000000a'$$,
  $$values (0::bigint, ''::text, true)$$,
  'la tarjeta borrada en cascada pierde código y etiqueta');
select is((select description from public.controls where id = '52000000-0000-0000-0000-00000000000a'), '',
  'el control borrado pierde su descripción');
select is((select rf_code from public.control_buttons where id = '62000000-0000-0000-0000-00000000000a'), 0::bigint,
  'el botón borrado pierde su código RF');

select results_eq(
  $$select cloud_version, panel_version from public.sync_conflicts
     where row_id = '32000000-0000-0000-0000-00000000000a'$$,
  $$values (null::jsonb, null::jsonb)$$,
  'los conflictos de la fila borrada pierden sus versiones');

update public.outputs
   set deleted_at = now(), updated_at = now(), updated_by = 'prueba', origin = 'cloud'
 where id = '72000000-0000-0000-0000-00000000000a';
select is((select alias from public.outputs where id = '72000000-0000-0000-0000-00000000000a'), '',
  'la salida borrada pierde su alias');

select lives_ok(
  $$insert into public.cards (installation_id, card_code, holder_id, updated_by, origin)
    values ('22000000-0000-0000-0000-00000000000a', 777, '32000000-0000-0000-0000-00000000000b', 'prueba', 'cloud')$$,
  'el código de una tarjeta borrada se puede volver a usar');

-- Un borrado reciente (Beto, hace 1 día) no se elimina.
update public.holders
   set deleted_at = now() - interval '1 day', updated_at = now(), updated_by = 'prueba', origin = 'cloud'
 where id = '32000000-0000-0000-0000-00000000000b';

-- Órdenes: una terminada vieja, una terminada reciente y una pendiente vieja.
insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by,
                                   expires_at, status, created_at, finished_at) values
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'test_output', 0, 'vieja', now() - interval '40 days', 'ok',
   now() - interval '40 days', now() - interval '40 days'),
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'test_output', 0, 'reciente', now(), 'ok', now(), now()),
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'test_output', 0, 'pendiente', now() - interval '40 days', 'pending',
   now() - interval '40 days', null);
insert into public.log_purges (tenant_id, installation_id, purged_at, deleted_count) values
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', now() - interval '40 days', 1),
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a', now(), 1);

-- Revisión más alta de lo que se va a eliminar (Ana y lo que colgaba de ella).
create temp table esperado as
select max(revision) as r from (
  select revision from public.holders where id = '32000000-0000-0000-0000-00000000000a'
  union all select revision from public.cards where id = '42000000-0000-0000-0000-00000000000a'
  union all select revision from public.controls where id = '52000000-0000-0000-0000-00000000000a'
  union all select revision from public.control_buttons where id = '62000000-0000-0000-0000-00000000000a'
  union all select revision from public.control_button_panels where button_id = '62000000-0000-0000-0000-00000000000a'
) x;

-- 2. Eliminación definitiva.
select is(private.purge_deleted_rows(30), 5, 'elimina el titular, su tarjeta, su control, su botón y su vínculo');

select results_eq(
  $$select (select count(*)::int from public.holders where id = '32000000-0000-0000-0000-00000000000a'),
           (select count(*)::int from public.cards where id = '42000000-0000-0000-0000-00000000000a'),
           (select count(*)::int from public.controls where id = '52000000-0000-0000-0000-00000000000a'),
           (select count(*)::int from public.control_buttons where id = '62000000-0000-0000-0000-00000000000a'),
           (select count(*)::int from public.control_button_panels
             where button_id = '62000000-0000-0000-0000-00000000000a')$$,
  $$values (0, 0, 0, 0, 0)$$,
  'las filas borradas hace más de 30 días ya no existen');
select is((select count(*)::int from public.audit_log
            where row_id in ('32000000-0000-0000-0000-00000000000a', '42000000-0000-0000-0000-00000000000a',
                             '52000000-0000-0000-0000-00000000000a', '62000000-0000-0000-0000-00000000000a')),
  0, 'su auditoría se elimina');
select is((select count(*)::int from public.holders where id = '32000000-0000-0000-0000-00000000000b'), 1,
  'un borrado de hace 1 día se conserva');
select is((select count(*)::int from public.outputs where id = '72000000-0000-0000-0000-00000000000a'), 1,
  'una salida borrada hoy se conserva');
select is((select purged_revision from public.installations where id = '22000000-0000-0000-0000-00000000000a'),
  (select r from esperado), 'purged_revision guarda la revisión más alta eliminada');
select results_eq(
  $$select requested_by from public.panel_commands
     where installation_id = '22000000-0000-0000-0000-00000000000a' order by requested_by$$,
  $$values ('pendiente'::text), ('reciente'::text)$$,
  'elimina solo las órdenes terminadas de más de 30 días');
select is((select count(*)::int from public.log_purges
            where installation_id = '22000000-0000-0000-0000-00000000000a'), 1,
  'elimina log_purges de más de 30 días');
select is((select count(*)::int from public.panels where id = 'c2000000-0000-0000-0000-00000000000b'), 0,
  'elimina el panel revocado sin actividad en 30 días');
select is((select count(*)::int from public.panels where id = 'c2000000-0000-0000-0000-00000000000a'), 1,
  'el panel activo se conserva');

select results_eq(
  $$select table_name from public.purged_rows
     where id in ('32000000-0000-0000-0000-00000000000a', '42000000-0000-0000-0000-00000000000a') order by 1$$,
  $$values ('cards'::text), ('holders'::text)$$,
  'quedan lápidas (solo ids) de lo eliminado');
select ok(not has_table_privilege('authenticated', 'public.purged_rows', 'SELECT')
          and not has_table_privilege('anon', 'public.purged_rows', 'SELECT'),
  'authenticated y anon no leen las lápidas');
select results_eq(
  $$select resolution from public.sync_conflicts
     where installation_id = '22000000-0000-0000-0000-00000000000a' order by 1$$,
  $$values ('sin revisar'::text)$$,
  'elimina los conflictos de filas eliminadas y los revisados de más de 30 días');
select is((select count(*)::int from public.panel_imports where panel_id = 'c2000000-0000-0000-0000-00000000000b'), 0,
  'elimina las importaciones viejas de paneles que no esperan revisión');

-- Push de un panel atrasado: la tarjeta eliminada no revive.
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('32000000-0000-0000-0000-00000000000c', '22000000-0000-0000-0000-00000000000a', 'persona', 'Caro', 'prueba', 'cloud');
select is(
  public.apply_panel_change('c2000000-0000-0000-0000-00000000000a', 'cambio-1', 'cards', 'upsert',
    '42000000-0000-0000-0000-00000000000a', now(), false,
    '{"card_code": 777, "holder_id": "32000000-0000-0000-0000-00000000000c", "description": "llavero"}',
    '{"card_code": 777}') ->> 'status',
  'superseded', 'el upsert de una tarjeta eliminada responde superseded');
select is((select count(*)::int from public.cards where id = '42000000-0000-0000-0000-00000000000a'), 0,
  'y no la recrea');
select is(
  public.apply_panel_change('c2000000-0000-0000-0000-00000000000a', 'cambio-2', 'holders', 'upsert',
    '32000000-0000-0000-0000-00000000000a', now(), false,
    '{"kind": "persona", "name": "Ana", "department": "", "address": "", "notes": "", "pin_ciphertext": null, "pin_lookup": null}',
    '{"name": "Ana"}') ->> 'status',
  'superseded', 'el upsert de un titular eliminado responde superseded');
select is((select count(*)::int from public.holders where id = '32000000-0000-0000-0000-00000000000a'), 0,
  'y no lo recrea');

-- Un conflicto nuevo de una fila borrada se guarda sin versiones.
insert into public.sync_conflicts (tenant_id, installation_id, panel_id, table_name, row_id, kind,
                                   cloud_version, panel_version, resolution) values
  ('12000000-0000-0000-0000-00000000000a', '22000000-0000-0000-0000-00000000000a',
   'c2000000-0000-0000-0000-00000000000a', 'holders', '32000000-0000-0000-0000-00000000000b', 'lww',
   '{"name": "Beto"}', '{"name": "Beto"}', 'nuevo');
select results_eq(
  $$select cloud_version, panel_version from public.sync_conflicts where resolution = 'nuevo'$$,
  $$values (null::jsonb, null::jsonb)$$,
  'un conflicto nuevo de una fila borrada no guarda versiones');

-- purged_revision nunca baja: una segunda corrida sin nada que eliminar no la cambia.
select private.purge_deleted_rows(30);
select is((select purged_revision from public.installations where id = '22000000-0000-0000-0000-00000000000a'),
  (select r from esperado), 'purged_revision no baja');

select * from finish();
rollback;
