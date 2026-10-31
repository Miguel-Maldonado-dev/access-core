-- Pruebas de control_button_panels: vínculos botón–panel con su salida por panel, y el
-- push del panel con semántica por panel (apply_panel_change).
-- Corren con `supabase test db` en el stack local.
-- Como postgres, auth.uid() es nulo: equivale a una escritura del servidor (llave secreta),
-- que trae updated_by/origin explícitos.
begin;
select plan(58);

-- Nombre de la restricción con la que choca una sentencia (o nulo si no choca).
create function pg_temp.constraint_of(p_sql text)
returns text
language plpgsql
as $$
declare
  v_constraint text;
begin
  execute p_sql;
  return null;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    return v_constraint;
end;
$$;

-- ---------------------------------------------------------------------------
-- Datos base
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-b@test.local');

insert into public.tenants (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'admin');

-- IA e IA2 son del tenant A; IB del tenant B.
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', 'Fracc A2'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Fracc B');

-- P1 y P2 en IA; P3 en IA2; PB en IB; PD y PE en IA (para el reclamo).
insert into public.panels (id, panel_code, panel_secret_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-000000000001', 'PNL-CBP1-0001', repeat('a', 64), '20000000-0000-0000-0000-00000000000a', 'active'),
  ('c0000000-0000-0000-0000-000000000002', 'PNL-CBP2-0002', repeat('a', 64), '20000000-0000-0000-0000-00000000000a', 'claimed'),
  ('c0000000-0000-0000-0000-000000000003', 'PNL-CBP3-0003', repeat('a', 64), '20000000-0000-0000-0000-0000000000a2', 'claimed'),
  ('c0000000-0000-0000-0000-00000000000b', 'PNL-CBPB-000B', repeat('a', 64), '20000000-0000-0000-0000-00000000000b', 'claimed'),
  ('c0000000-0000-0000-0000-00000000000d', 'PNL-CBPD-000D', repeat('a', 64), '20000000-0000-0000-0000-00000000000a', 'claimed'),
  ('c0000000-0000-0000-0000-00000000000e', 'PNL-CBPE-000E', repeat('a', 64), '20000000-0000-0000-0000-00000000000a', 'claimed');

insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'x', 'cloud'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a2', 'persona', 'Beto', 'x', 'cloud');
insert into public.controls (id, installation_id, holder_id, updated_by, origin) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000001', 'x', 'cloud'),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a2', '30000000-0000-0000-0000-000000000002', 'x', 'cloud');
-- B1 y B2 comparten el botón 0 del control C1 (ya no es único por control); B3 es el botón 1.
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_by, origin) values
  ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 0, 1001, 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 0, 1002, 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 1, 1003, 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 2, 1005, 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000001', 3, 1006, 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000a2', '50000000-0000-0000-0000-000000000002', 0, 1009, 'x', 'cloud');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select has_table('public', 'control_button_panels', 'existe la tabla control_button_panels');
select columns_are('public', 'control_button_panels',
  array['id', 'tenant_id', 'installation_id', 'button_id', 'panel_id', 'output_index',
        'updated_at', 'updated_by', 'origin', 'deleted_at', 'revision'],
  'control_button_panels tiene las columnas del contrato');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.control_button_panels'::regclass),
  'RLS activa en control_button_panels');
select has_index('public', 'control_button_panels', 'control_button_panels_button_panel_live_key',
  'existe el indice unico vivo (button_id, panel_id)');
select hasnt_column('public', 'control_buttons', 'output_index', 'control_buttons ya no tiene output_index');
select hasnt_index('public', 'control_buttons', 'control_buttons_control_button_live_key',
  'se borro el indice unico (control_id, button) de control_buttons');
select ok(
  has_column_privilege('authenticated', 'public.control_button_panels', 'installation_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.control_button_panels', 'button_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.control_button_panels', 'panel_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.control_button_panels', 'output_index', 'INSERT')
  and has_column_privilege('authenticated', 'public.control_button_panels', 'output_index', 'UPDATE')
  and has_column_privilege('authenticated', 'public.control_button_panels', 'deleted_at', 'UPDATE'),
  'authenticated inserta (installation_id, button_id, panel_id, output_index) y actualiza (output_index, deleted_at)');
select ok(
  not has_column_privilege('authenticated', 'public.control_button_panels', 'panel_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.control_button_panels', 'button_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.control_button_panels', 'revision', 'INSERT')
  and not has_column_privilege('authenticated', 'public.control_button_panels', 'origin', 'INSERT')
  and not has_column_privilege('authenticated', 'public.control_button_panels', 'updated_by', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.control_button_panels', 'DELETE'),
  'authenticated no cambia el panel ni el boton, ni escribe revision, origin o updated_by, ni borra');
select ok(not has_table_privilege('anon', 'public.control_button_panels', 'SELECT'),
  'anon no lee control_button_panels');

-- ---------------------------------------------------------------------------
-- Alta, revisión y auditoría (escrituras del servidor)
-- ---------------------------------------------------------------------------
create temp table rev_antes as
  select revision from public.installations where id = '20000000-0000-0000-0000-00000000000a';
insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
values ('d0000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-00000000000a',
        '60000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 2,
        'panel:PNL-CBP1-0001', 'panel:PNL-CBP1-0001');
select is(
  (select revision from public.control_button_panels where id = 'd0000000-0000-0000-0000-000000000011'),
  (select revision + 1 from rev_antes),
  'el alta de un vinculo toma la siguiente revision de la instalacion');
select results_eq(
  $$select tenant_id, updated_by, origin from public.control_button_panels
    where id = 'd0000000-0000-0000-0000-000000000011'$$,
  $$values ('10000000-0000-0000-0000-00000000000a'::uuid, 'panel:PNL-CBP1-0001'::text, 'panel:PNL-CBP1-0001'::text)$$,
  'tenant_id lo pone el trigger y el servidor conserva updated_by y origin');
select is(
  (select count(*)::int from public.audit_log
   where table_name = 'control_button_panels' and row_id = 'd0000000-0000-0000-0000-000000000011'
     and op = 'insert' and updated_by = 'panel:PNL-CBP1-0001'),
  1, 'audit_log registra el alta del vinculo');
select lives_ok(
  $$insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('d0000000-0000-0000-0000-000000000016', '20000000-0000-0000-0000-00000000000a',
            '60000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001', null, 'x', 'cloud')$$,
  'un vinculo puede no tener salida (output_index nulo)');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-000000000002', 4, 'x', 'cloud')$$,
  '23514', null, 'output_index fuera de 0..3 se rechaza');

-- ---------------------------------------------------------------------------
-- Misma instalación
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-0000000000a2', '60000000-0000-0000-0000-000000000001',
            'c0000000-0000-0000-0000-000000000003', 0, 'x', 'cloud')$$,
  '23503', null, 'un vinculo no puede apuntar a un boton de otra instalacion');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-000000000003', 0, 'x', 'cloud')$$,
  '23503', null, 'un vinculo no puede apuntar a un panel de otra instalacion');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-00000000000b', 0, 'x', 'cloud')$$,
  '23503', null, 'un vinculo no puede apuntar a un panel de otro tenant');

-- ---------------------------------------------------------------------------
-- Unicidad
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001',
            'c0000000-0000-0000-0000-000000000001', 1, 'x', 'cloud')$$,
  '23505', null, 'dos vinculos vivos del mismo boton al mismo panel fallan');

-- B2 comparte el botón 0 de C1 con B1 (vinculado a P1): en P2 se acepta, en P1 no.
select lives_ok(
  $$insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('d0000000-0000-0000-0000-000000000022', '20000000-0000-0000-0000-00000000000a',
            '60000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 0, 'x', 'cloud')$$,
  'dos botones vivos del mismo control con el mismo numero, en paneles distintos, se aceptan');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000002',
            'c0000000-0000-0000-0000-000000000001', 0, 'x', 'cloud')$$,
  '23505', null, 'dos botones vivos del mismo control con el mismo numero, en el mismo panel, fallan');
select is(
  pg_temp.constraint_of(
    $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
      values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000002',
              'c0000000-0000-0000-0000-000000000001', 0, 'x', 'cloud')$$),
  'control_button_panels_panel_button_live_key',
  'el choque por panel se reporta con la restriccion control_button_panels_panel_button_live_key');

-- B3 (botón 1) vinculado a P1: cambiarlo al número 0 choca con B1 en P1.
insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
values ('d0000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-00000000000a',
        '60000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 1, 'x', 'cloud');
select throws_ok(
  $$update public.control_buttons set button = 0, updated_by = 'x', origin = 'cloud'
    where id = '60000000-0000-0000-0000-000000000003'$$,
  '23505', null, 'cambiar el numero de un boton a uno ya usado en uno de sus paneles falla');
select lives_ok(
  $$update public.control_buttons set button = 1, updated_by = 'x', origin = 'cloud'
    where id = '60000000-0000-0000-0000-000000000002'$$,
  'cambiar el numero de un boton a uno libre en sus paneles se acepta (B2 pasa a 1; B3 es 1 pero solo en P1)');

-- Un vínculo borrado o un botón borrado ya no cuentan.
update public.control_button_panels set deleted_at = now(), updated_by = 'x', origin = 'cloud'
where id = 'd0000000-0000-0000-0000-000000000031';
select lives_ok(
  $$insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('d0000000-0000-0000-0000-000000000032', '20000000-0000-0000-0000-00000000000a',
            '60000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 3, 'x', 'cloud')$$,
  'si el vinculo anterior esta borrado, el mismo (boton, panel) se vuelve a vincular');
select throws_ok(
  $$update public.control_button_panels set deleted_at = null, updated_by = 'x', origin = 'cloud'
    where id = 'd0000000-0000-0000-0000-000000000031'$$,
  '23505', null, 'revivir un vinculo que choca con otro vivo falla');

-- ---------------------------------------------------------------------------
-- Cascada lógica desde control_buttons
-- ---------------------------------------------------------------------------
insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
values ('d0000000-0000-0000-0000-000000000051', '20000000-0000-0000-0000-00000000000a',
        '60000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 0, 'x', 'cloud'),
       ('d0000000-0000-0000-0000-000000000052', '20000000-0000-0000-0000-00000000000a',
        '60000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000002', 1, 'x', 'cloud');
update public.control_buttons
set deleted_at = '2026-10-30 12:00:00+00', updated_at = '2026-10-30 12:00:00+00',
    updated_by = 'panel:PNL-CBP1-0001', origin = 'panel:PNL-CBP1-0001'
where id = '60000000-0000-0000-0000-000000000005';
select is(
  (select count(*)::int from public.control_button_panels
   where button_id = '60000000-0000-0000-0000-000000000005'
     and deleted_at = '2026-10-30 12:00:00+00' and updated_at = '2026-10-30 12:00:00+00'
     and updated_by = 'panel:PNL-CBP1-0001' and origin = 'panel:PNL-CBP1-0001'),
  2, 'borrar un boton borra sus vinculos con los datos del borrado del padre');
select is(
  (select count(distinct revision)::int from public.control_button_panels
   where button_id = '60000000-0000-0000-0000-000000000005'),
  2, 'cada vinculo borrado en cascada recibe su propia revision');
select is(
  (select count(*)::int from public.audit_log
   where table_name = 'control_button_panels'
     and row_id in ('d0000000-0000-0000-0000-000000000051', 'd0000000-0000-0000-0000-000000000052')
     and op = 'delete' and updated_by = 'panel:PNL-CBP1-0001'),
  2, 'audit_log registra el borrado en cascada de los vinculos');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000005',
            'c0000000-0000-0000-0000-000000000001', 0, 'x', 'cloud')$$,
  '23503', null, 'no se puede vincular un boton borrado');

-- ---------------------------------------------------------------------------
-- claim_panel borra los vínculos vivos del panel en la instalación anterior
-- ---------------------------------------------------------------------------
insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_by, origin)
values ('d0000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-00000000000a',
        '60000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-00000000000d', 0, 'x', 'cloud'),
       ('d0000000-0000-0000-0000-0000000000e1', '20000000-0000-0000-0000-00000000000a',
        '60000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-00000000000e', 0, 'x', 'cloud');
update public.panels set status = 'revoked'
where id in ('c0000000-0000-0000-0000-00000000000d', 'c0000000-0000-0000-0000-00000000000e');
update public.panels set status = 'pending', installation_id = null, claim_code_hash = repeat('7', 64)
where id in ('c0000000-0000-0000-0000-00000000000d', 'c0000000-0000-0000-0000-00000000000e');

select isnt(
  public.claim_panel('c0000000-0000-0000-0000-00000000000d', repeat('7', 64), '20000000-0000-0000-0000-0000000000a2'),
  null::jsonb, 'PD se reclama en IA2');
select results_eq(
  $$select deleted_at is not null, updated_at = now(), updated_by, origin
    from public.control_button_panels where id = 'd0000000-0000-0000-0000-0000000000d1'$$,
  $$values (true, true, 'system:reclamo'::text, 'cloud'::text)$$,
  'reclamar en otra instalacion borra logicamente los vinculos viejos del panel, con autor neutro');
select is(
  (select count(*)::int from public.audit_log
   where row_id = 'd0000000-0000-0000-0000-0000000000d1' and op = 'delete' and updated_by = 'system:reclamo'),
  1, 'audit_log registra el borrado del vinculo con el autor neutro');
select isnt(
  public.claim_panel('c0000000-0000-0000-0000-00000000000e', repeat('7', 64), '20000000-0000-0000-0000-00000000000a'),
  null::jsonb, 'PE se reclama de vuelta en IA');
select is((select deleted_at from public.control_button_panels where id = 'd0000000-0000-0000-0000-0000000000e1'),
  null::timestamptz, 'volver a la misma instalacion conserva los vinculos vivos');

-- ---------------------------------------------------------------------------
-- Push del panel por panel (apply_panel_change con control_buttons y controls)
-- ---------------------------------------------------------------------------
-- Datos propios: titulares H3 y H4, controles K1 y K4 (de H3) y K3 (de H4), en IA.
-- Fechas fijas: lo de la nube es de 2026-01-01; los cambios del panel, posteriores.
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-00000000000a', 'persona', 'Carla', 'x', 'cloud'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-00000000000a', 'persona', 'Dario', 'x', 'cloud');
insert into public.controls (id, installation_id, holder_id, updated_at, updated_by, origin) values
  ('50000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000003', '2026-01-01', 'x', 'cloud'),
  ('50000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000004', '2026-01-01', 'x', 'cloud'),
  ('50000000-0000-0000-0000-000000000014', '20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000003', '2026-01-01', 'x', 'cloud');
-- K1: E1 (0) en P1 y P2; E2 (1) en P1; E3 (1) en P2; E5 (2) en P2; E6 (3) en P1.
-- K4: G1 (0) en P1 y P2; G2 (1) solo en P1.
insert into public.control_buttons (id, installation_id, control_id, button, rf_code, updated_at, updated_by, origin) values
  ('60000000-0000-0000-0000-000000000021', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000011', 0, 2001, '2026-01-01', 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000022', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000011', 1, 2002, '2026-01-01', 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000023', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000011', 1, 2003, '2026-01-01', 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000025', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000011', 2, 2005, '2026-01-01', 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000026', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000011', 3, 2006, '2026-01-01', 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000014', 0, 2020, '2026-01-01', 'x', 'cloud'),
  ('60000000-0000-0000-0000-000000000032', '20000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000014', 1, 2021, '2026-01-01', 'x', 'cloud');
insert into public.control_button_panels (id, installation_id, button_id, panel_id, output_index, updated_at, updated_by, origin) values
  ('d0000000-0000-0000-0000-000000000101', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000021', 'c0000000-0000-0000-0000-000000000001', 0, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000102', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000021', 'c0000000-0000-0000-0000-000000000002', 1, '2026-03-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000103', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000022', 'c0000000-0000-0000-0000-000000000001', 1, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000104', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000023', 'c0000000-0000-0000-0000-000000000002', 1, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000105', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000025', 'c0000000-0000-0000-0000-000000000002', 2, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000106', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000026', 'c0000000-0000-0000-0000-000000000001', 3, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000111', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000031', 'c0000000-0000-0000-0000-000000000001', 0, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000112', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000031', 'c0000000-0000-0000-0000-000000000002', 1, '2026-01-01', 'x', 'cloud'),
  ('d0000000-0000-0000-0000-000000000113', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000032', 'c0000000-0000-0000-0000-000000000001', 1, '2026-01-01', 'x', 'cloud');

-- Mover un vínculo de botón (escritura del servidor) también revisa la unicidad por panel:
-- E2 (número 1) en P2 chocaría con E3, que ya ocupa el 1 de K1 en P2.
select is(
  pg_temp.constraint_of($$update public.control_button_panels set button_id = '60000000-0000-0000-0000-000000000022'
    where id = 'd0000000-0000-0000-0000-000000000105'$$),
  'control_button_panels_panel_button_live_key',
  'cambiar el boton de un vinculo a uno cuyo numero ya esta en uso en ese panel da 23505');

-- Alta en P1 de un botón con el número 0 de K1, que en P1 ocupa E1.
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-000000000001', 'cbp-1', 'control_buttons', 'upsert',
    'f0000000-0000-0000-0000-000000000001', '2026-06-01', false,
    '{"control_id": "50000000-0000-0000-0000-000000000011", "button": 0, "rf_code": 2010, "output_id": 2}',
    '{"op": "upsert"}'),
  '{"status": "rejected", "reason": "duplicado"}'::jsonb,
  'un alta con un numero de boton ocupado en ese panel queda rejected/duplicado');
select results_eq(
  $$select table_name, kind, cloud_version ->> 'id', cloud_version ->> 'panel_id', (cloud_version ->> 'linked')::boolean,
           (cloud_version ->> 'output_index')::int
    from public.sync_conflicts where row_id = 'f0000000-0000-0000-0000-000000000001'$$,
  $$values ('control_buttons'::text, 'unique'::text, '60000000-0000-0000-0000-000000000021'::text,
            'c0000000-0000-0000-0000-000000000001'::text, true, 0)$$,
  'el conflicto unique se registra como control_buttons con la version del boton que ocupa el numero en ese panel');

-- P2 cambia la salida de E1 con una hora posterior al botón pero anterior a su vínculo con P2.
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-000000000002', 'cbp-2', 'control_buttons', 'upsert',
    '60000000-0000-0000-0000-000000000021', '2026-02-01', false,
    '{"control_id": "50000000-0000-0000-0000-000000000011", "button": 0, "rf_code": 2001, "output_id": 3}',
    '{"op": "upsert"}'),
  '{"status": "superseded"}'::jsonb,
  'un cambio de salida mas viejo que el vinculo de ese panel queda superseded');
select results_eq(
  $$select table_name, kind, cloud_version ->> 'panel_id', (cloud_version ->> 'output_index')::int
    from public.sync_conflicts where row_id = '60000000-0000-0000-0000-000000000021'$$,
  $$values ('control_buttons'::text, 'lww'::text, 'c0000000-0000-0000-0000-000000000002'::text, 1)$$,
  'el conflicto lww del vinculo se registra como control_buttons con la salida de ese panel');
select is(
  (select output_index from public.control_button_panels where id = 'd0000000-0000-0000-0000-000000000102'),
  1, 'el vinculo mas nuevo conserva su salida');

-- Fusión: P2 da de alta un control K2 de Carla y un botón con el código de E6 (de K1, Carla).
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-000000000002', 'cbp-3', 'controls', 'upsert',
    '50000000-0000-0000-0000-000000000012', '2026-06-01', false,
    '{"holder_id": "30000000-0000-0000-0000-000000000003", "description": "K2"}', '{"op": "upsert"}') ->> 'status',
  'applied', 'P2 da de alta el control K2');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-000000000002', 'cbp-4', 'control_buttons', 'upsert',
    'f0000000-0000-0000-0000-000000000002', '2026-06-01', false,
    '{"control_id": "50000000-0000-0000-0000-000000000012", "button": 0, "rf_code": 2006, "output_id": 2}',
    '{"op": "upsert"}'),
  '{"status": "rejected", "reason": "fusionado"}'::jsonb,
  'un codigo RF vivo del mismo titular se fusiona');
select results_eq(
  $$select output_index, origin from public.control_button_panels
    where button_id = '60000000-0000-0000-0000-000000000026' and panel_id = 'c0000000-0000-0000-0000-000000000002'
      and deleted_at is null$$,
  $$values (2, 'panel:PNL-CBP2-0002'::text)$$,
  'la fusion vincula el boton existente a P2 con la salida enviada');
select ok(
  (select deleted_at is not null from public.controls where id = '50000000-0000-0000-0000-000000000012')
  and not exists (select 1 from public.control_buttons where id = 'f0000000-0000-0000-0000-000000000002')
  and not exists (select 1 from public.sync_conflicts where row_id = 'f0000000-0000-0000-0000-000000000002'),
  'la fusion borra el control vacio que creo P2, no crea el boton nuevo ni registra conflicto');

-- Con otro titular (K3 es de Dario): duplicado, como antes.
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-000000000002', 'cbp-5', 'control_buttons', 'upsert',
    'f0000000-0000-0000-0000-000000000003', '2026-06-01', false,
    '{"control_id": "50000000-0000-0000-0000-000000000013", "button": 0, "rf_code": 2006, "output_id": 0}',
    '{"op": "upsert"}'),
  '{"status": "rejected", "reason": "duplicado"}'::jsonb,
  'un codigo RF vivo de otro titular queda rejected/duplicado');
select is(
  (select cloud_version ->> 'id' from public.sync_conflicts where row_id = 'f0000000-0000-0000-0000-000000000003'),
  '60000000-0000-0000-0000-000000000026', 'el conflicto unique lleva el boton que tiene el codigo');

-- Borrado de K4 desde P1: G1 sigue en P2; G2 (solo en P1) se borra; K4 sigue vivo.
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-000000000001', 'cbp-6', 'controls', 'delete',
    '50000000-0000-0000-0000-000000000014', '2026-06-01', false, null, '{"op": "delete"}') ->> 'status',
  'applied', 'el borrado de un control desde P1 queda applied');
select results_eq(
  $$select (select deleted_at is null from public.controls where id = '50000000-0000-0000-0000-000000000014'),
           (select deleted_at is null from public.control_buttons where id = '60000000-0000-0000-0000-000000000031'),
           (select deleted_at is null from public.control_button_panels where id = 'd0000000-0000-0000-0000-000000000111'),
           (select deleted_at is null from public.control_button_panels where id = 'd0000000-0000-0000-0000-000000000112'),
           (select deleted_at is null from public.control_buttons where id = '60000000-0000-0000-0000-000000000032')$$,
  $$values (true, true, false, true, false)$$,
  'quedan vivos el control, G1 y su vinculo con P2; se borran los vinculos con P1 y G2');

select ok(
  not has_function_privilege('authenticated', 'private.push_control_button(uuid, uuid, text, uuid, timestamptz, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.push_control_delete(uuid, uuid, uuid, timestamptz, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.push_button_link(uuid, uuid, uuid, timestamptz, text, int, boolean)', 'execute')
  and not has_function_privilege('anon', 'private.unique_conflict_version(uuid, uuid, text, jsonb)', 'execute'),
  'authenticated y anon no ejecutan las funciones del push por panel');

-- ---------------------------------------------------------------------------
-- Usuario autenticado, admin del tenant A
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select lives_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-00000000000e', 2)$$,
  'miembro de A vincula un boton a un panel de su instalacion');
select results_eq(
  $$select origin, updated_by from public.control_button_panels where button_id = '60000000-0000-0000-0000-000000000003'
    and panel_id = 'c0000000-0000-0000-0000-00000000000e'$$,
  $$values ('cloud'::text, 'user:00000000-0000-0000-0000-0000000000a1'::text)$$,
  'el alta como usuario deja origin=cloud y updated_by=user:<uid>');
select lives_ok(
  $$update public.control_button_panels set output_index = 3 where button_id = '60000000-0000-0000-0000-000000000003'
    and panel_id = 'c0000000-0000-0000-0000-00000000000e'$$,
  'miembro de A cambia la salida de un vinculo');
select throws_ok(
  $$update public.control_button_panels set panel_id = 'c0000000-0000-0000-0000-000000000001'
    where button_id = '60000000-0000-0000-0000-000000000003'
    and panel_id = 'c0000000-0000-0000-0000-00000000000e'$$,
  '42501', null, 'authenticated no puede mover un vinculo de panel');
select lives_ok(
  $$update public.control_button_panels set deleted_at = now() where button_id = '60000000-0000-0000-0000-000000000003'
    and panel_id = 'c0000000-0000-0000-0000-00000000000e'$$,
  'miembro de A borra logicamente un vinculo');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-00000000000b', 0)$$,
  '23503', null, 'como usuario, un panel de otro tenant (no visible) se rechaza');

-- Miembro de B no ve ni escribe vínculos de A
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.control_button_panels), 0, 'miembro de B ve 0 vinculos de A');
select throws_ok(
  $$insert into public.control_button_panels (installation_id, button_id, panel_id, output_index)
    values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000003',
            'c0000000-0000-0000-0000-000000000002', 0)$$,
  '42501', null, 'miembro de B no puede vincular en una instalacion de A');
reset role;

set local role anon;
select throws_ok($$select id from public.control_button_panels$$, '42501', null, 'anon no puede leer los vinculos');
reset role;

select * from finish();
rollback;
