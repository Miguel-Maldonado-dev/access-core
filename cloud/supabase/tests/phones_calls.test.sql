-- Pruebas de la apertura por llamada en la nube: phones, panel_call_settings y
-- profile_panel_rules.allow_call. Corren con `supabase test db`.
-- Como postgres, auth.uid() es nulo: equivale a una escritura del servidor (llave secreta).
begin;
select plan(39);

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
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'x', 'cloud'),
  ('30000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000a', 'persona', 'Beto', 'x', 'cloud');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.phones'::regclass), 'RLS activa en phones');
select ok((select relrowsecurity from pg_class where oid = 'public.panel_call_settings'::regclass),
  'RLS activa en panel_call_settings');
select fk_ok('public', 'phones', array['installation_id', 'holder_id'],
  'public', 'holders', array['installation_id', 'id'], 'phones apunta a titulares de su instalación');
select has_index('public', 'phones', 'phones_installation_id_holder_id_idx', array['installation_id', 'holder_id'],
  'índice de la FK hacia holders');
select col_default_is('public', 'panel_call_settings', 'call_limit_per_minute', '3',
  'call_limit_per_minute vale 3 por omisión');
select col_default_is('public', 'profile_panel_rules', 'allow_call', 'false', 'allow_call vale false por omisión');
select ok(has_column_privilege('authenticated', 'public.profile_panel_rules', 'allow_call', 'INSERT')
          and has_column_privilege('authenticated', 'public.profile_panel_rules', 'allow_call', 'UPDATE'),
  'authenticated crea y edita allow_call (como allow_rf)');
select ok(not has_table_privilege('authenticated', 'public.panel_call_settings', 'INSERT')
          and not has_column_privilege('authenticated', 'public.panel_call_settings', 'deleted_at', 'UPDATE'),
  'authenticated no crea ni borra configuraciones de llamadas');

-- ---------------------------------------------------------------------------
-- Una fila de panel_call_settings por panel
-- ---------------------------------------------------------------------------
select isnt(public.claim_panel('c0000000-0000-0000-0000-00000000000a', repeat('1', 64),
                               '20000000-0000-0000-0000-00000000000a'), null, 'el panel se reclama');
select is((select count(*)::int from public.panel_call_settings
            where panel_id = 'c0000000-0000-0000-0000-00000000000a' and deleted_at is null), 1,
  'reclamar el panel crea su configuración de llamadas');
select is((select (enabled, mode, output_index, menu_mask, default_output, call_limit_per_minute)::text
             from public.panel_call_settings where panel_id = 'c0000000-0000-0000-0000-00000000000a'),
  '(f,single,0,0,,3)', 'la configuración nace apagada, en "Una salida" y con límite 3');
select is((select count(*)::int from public.panels p
            where p.installation_id is not null
              and p.status in ('claimed', 'staging', 'awaiting_review', 'active')
              and not exists (select 1 from public.panel_call_settings s
                              where s.panel_id = p.id and s.deleted_at is null)), 0,
  'cada panel vivo tiene su fila de panel_call_settings');
select throws_ok(
  $$update public.panel_call_settings set mode = 'menu', menu_mask = 3, default_output = 2
     where panel_id = 'c0000000-0000-0000-0000-00000000000a'$$,
  '23514', null, 'la salida predeterminada debe estar en el menú');
select throws_ok(
  $$update public.panel_call_settings set call_limit_per_minute = 21
     where panel_id = 'c0000000-0000-0000-0000-00000000000a'$$,
  '23514', null, 'call_limit_per_minute va de 1 a 20');

-- ---------------------------------------------------------------------------
-- phones: número único vivo y formato
-- ---------------------------------------------------------------------------
insert into public.phones (id, installation_id, holder_id, number, description, updated_by, origin) values
  ('50000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   '30000000-0000-0000-0000-00000000000a', '5512345678', 'Celular', 'x', 'cloud');
select throws_ok(
  $$insert into public.phones (installation_id, holder_id, number, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', '5512345678', 'x', 'cloud')$$,
  '23505', null, 'el número es único entre los teléfonos vivos');
select throws_ok(
  $$insert into public.phones (installation_id, holder_id, number, updated_by, origin)
    values ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', '551234567', 'x', 'cloud')$$,
  '23514', null, 'un número de 9 dígitos se rechaza');

update public.phones set deleted_at = now(), updated_by = 'x' where id = '50000000-0000-0000-0000-00000000000a';
select is((select number || '|' || description from public.phones where id = '50000000-0000-0000-0000-00000000000a'),
  '|', 'borrar un teléfono lo vacía');
select lives_ok(
  $$insert into public.phones (id, installation_id, holder_id, number, updated_by, origin)
    values ('50000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000a',
            '30000000-0000-0000-0000-00000000000b', '5512345678', 'x', 'cloud')$$,
  'tras borrar el primero, el número se puede volver a usar');
select is((select op from public.audit_log where table_name = 'phones'
            and row_id = '50000000-0000-0000-0000-00000000000a' order by id desc limit 1), 'delete',
  'la auditoría registra el borrado del teléfono');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.phones), 0, 'otro tenant no ve los teléfonos');
select is((select count(*)::int from public.panel_call_settings), 0, 'otro tenant no ve la configuración');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is((select count(*)::int from public.panel_call_settings), 1, 'el técnico ve la configuración');
update public.panel_call_settings set enabled = true where panel_id = 'c0000000-0000-0000-0000-00000000000a';
select is((select enabled from public.panel_call_settings where panel_id = 'c0000000-0000-0000-0000-00000000000a'),
  false, 'el técnico no puede actualizar panel_call_settings');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
update public.panel_call_settings set enabled = true, mode = 'menu', menu_mask = 5, default_output = 2
 where panel_id = 'c0000000-0000-0000-0000-00000000000a';
select is((select enabled from public.panel_call_settings where panel_id = 'c0000000-0000-0000-0000-00000000000a'),
  true, 'el admin sí la actualiza');
reset role;

-- ---------------------------------------------------------------------------
-- apply_panel_change: call_settings y phones
-- ---------------------------------------------------------------------------
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'll-1', 'call_settings', 'upsert',
    '90000000-0000-0000-0000-00000000000a', now() + interval '1 minute', false,
    '{"enabled": true, "mode": "single", "output_id": 3, "menu_mask": 0, "default_output": null,
      "call_limit_per_minute": 5}', null) ->> 'status',
  'applied', 'call_settings se aplica a la fila del panel aunque el id no coincida');
select is((select (mode, output_index, call_limit_per_minute)::text from public.panel_call_settings
            where panel_id = 'c0000000-0000-0000-0000-00000000000a' and deleted_at is null),
  '(single,3,5)', 'la fila del panel toma los valores del panel');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'll-2', 'call_settings', 'upsert',
    '90000000-0000-0000-0000-00000000000a', now() - interval '1 day', false,
    '{"enabled": false, "mode": "single", "output_id": 0, "menu_mask": 0, "default_output": null,
      "call_limit_per_minute": 3}', null) ->> 'status',
  'superseded', 'un cambio más viejo que el de la nube pierde');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'll-3', 'call_settings', 'delete',
    '90000000-0000-0000-0000-00000000000a', now() + interval '2 minutes', false, null, null) ->> 'status',
  'superseded', 'un delete de call_settings nunca se aplica');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'tel-1', 'phones', 'upsert',
    '50000000-0000-0000-0000-00000000000c', now(), false,
    '{"holder_id": "30000000-0000-0000-0000-00000000000a", "number": "5598765432", "description": ""}', null)
    ->> 'status', 'applied', 'el panel da de alta un teléfono');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'tel-2', 'phones', 'upsert',
    '50000000-0000-0000-0000-00000000000d', now(), false,
    '{"holder_id": "30000000-0000-0000-0000-00000000000a", "number": "5598765432", "description": ""}', null)
    ->> 'reason', 'duplicado', 'un número repetido desde el panel se rechaza como duplicado');

-- push_permission sin allow_call conserva el de la nube.
insert into public.access_profiles (id, installation_id, name, local_permission_id, updated_at, updated_by, origin)
values ('60000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'Residentes', 1,
        now() - interval '1 day', 'x', 'cloud');
insert into public.profile_panel_rules (installation_id, profile_id, panel_id, output_mask, card_reader_mask,
  pin_reader_mask, allow_call, weekday_mask, start_minute, end_minute, updated_at, updated_by, origin)
values ('20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-00000000000a',
        'c0000000-0000-0000-0000-00000000000a', 1, 1, 1, true, 127, 0, 1439, now() - interval '1 day', 'x', 'cloud');
select is(
  public.apply_panel_change('c0000000-0000-0000-0000-00000000000a', 'perm-1', 'permissions', 'upsert',
    '60000000-0000-0000-0000-00000000000a', now() + interval '5 minutes', false,
    '{"permission_id": 1, "name": "Residentes", "output_mask": 3, "card_reader_mask": 1, "pin_reader_mask": 1,
      "allow_rf": false, "weekday_mask": 127, "start_minute": 0, "end_minute": 1439}', null) ->> 'status',
  'applied', 'un panel v7 actualiza la regla');
select is((select allow_call from public.profile_panel_rules where profile_id = '60000000-0000-0000-0000-00000000000a'),
  true, 'push_permission sin allow_call conserva el valor de la nube');

-- ---------------------------------------------------------------------------
-- Cascada del titular y purga
-- ---------------------------------------------------------------------------
update public.holders set deleted_at = now(), updated_by = 'x' where id = '30000000-0000-0000-0000-00000000000a';
select is((select count(*)::int from public.phones
            where holder_id = '30000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'borrar el titular borra lógicamente sus teléfonos');

update public.phones set deleted_at = now() - interval '40 days' where id = '50000000-0000-0000-0000-00000000000a';
select ok(private.purge_deleted_rows(30) >= 1, 'la purga elimina filas');
select ok(not exists (select 1 from public.phones where id = '50000000-0000-0000-0000-00000000000a')
          and exists (select 1 from public.purged_rows where id = '50000000-0000-0000-0000-00000000000a'
                      and table_name = 'phones'),
  'purge_deleted_rows elimina el teléfono y deja su lápida');

-- Revocación y eliminación de la instalación
select ok(public.revoke_panel('c0000000-0000-0000-0000-00000000000a'), 'el panel se revoca');
select is((select count(*)::int from public.panel_call_settings
            where panel_id = 'c0000000-0000-0000-0000-00000000000a' and deleted_at is null), 0,
  'revocar el panel borra lógicamente su configuración de llamadas');
select ok(public.delete_installation('20000000-0000-0000-0000-00000000000a'), 'la instalación se elimina');
select ok(not exists (select 1 from public.phones)
          and not exists (select 1 from public.panel_call_settings)
          and not exists (select 1 from public.audit_log where table_name in ('phones', 'panel_call_settings')),
  'eliminar la instalación borra teléfonos, configuraciones y su auditoría');

select * from finish();
rollback;
