-- Pruebas de la apertura remota (etapa 3): profile_panel_rules.allow_remote y las órdenes
-- remote_open de panel_commands (holder_id y reason). Corren con `supabase test db`.
-- Como postgres, auth.uid() es nulo: equivale a una escritura del servidor (llave secreta).
begin;
select plan(21);

-- ---------------------------------------------------------------------------
-- profile_panel_rules.allow_remote
-- ---------------------------------------------------------------------------
select has_column('public', 'profile_panel_rules', 'allow_remote', 'profile_panel_rules tiene allow_remote');
select col_type_is('public', 'profile_panel_rules', 'allow_remote', 'boolean', 'allow_remote es boolean');
select col_not_null('public', 'profile_panel_rules', 'allow_remote', 'allow_remote es obligatorio');
select col_default_is('public', 'profile_panel_rules', 'allow_remote', 'false', 'allow_remote vale false por omisión');
select ok(has_column_privilege('authenticated', 'public.profile_panel_rules', 'allow_remote', 'INSERT')
          and has_column_privilege('authenticated', 'public.profile_panel_rules', 'allow_remote', 'UPDATE')
          and has_column_privilege('authenticated', 'public.profile_panel_rules', 'allow_remote', 'SELECT'),
  'authenticated lee, crea y edita allow_remote (como allow_rf)');

-- ---------------------------------------------------------------------------
-- panel_commands: holder_id y reason
-- ---------------------------------------------------------------------------
select col_type_is('public', 'panel_commands', 'holder_id', 'uuid', 'panel_commands.holder_id es uuid');
select col_type_is('public', 'panel_commands', 'reason', 'integer', 'panel_commands.reason es int');
select ok(has_column_privilege('authenticated', 'public.panel_commands', 'holder_id', 'SELECT')
          and has_column_privilege('authenticated', 'public.panel_commands', 'reason', 'SELECT'),
  'authenticated lee holder_id y reason');
select ok(not has_column_privilege('authenticated', 'public.panel_commands', 'holder_id', 'INSERT')
          and not has_column_privilege('authenticated', 'public.panel_commands', 'reason', 'UPDATE'),
  'authenticated no escribe holder_id ni reason');
select fk_ok('public', 'panel_commands', array['installation_id', 'holder_id'],
  'public', 'holders', array['installation_id', 'id'],
  'panel_commands (installation_id, holder_id) es FK hacia holders de la misma instalación');
select has_index('public', 'panel_commands', 'panel_commands_installation_id_holder_id_idx',
  array['installation_id', 'holder_id'], 'índice de la FK hacia holders');

-- Datos base
insert into public.tenants (id, name) values ('10000000-0000-0000-0000-00000000000a', 'Tenant A');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000a', 'Fracc C');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('2', 64), repeat('3', 64),
   '20000000-0000-0000-0000-00000000000a', 'active');
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('30000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'persona', 'Ana', 'prueba', 'cloud'),
  ('30000000-0000-0000-0000-00000000000c', '20000000-0000-0000-0000-00000000000c', 'persona', 'Carla', 'prueba', 'cloud');

select lives_ok(
  $$insert into public.panel_commands (id, tenant_id, installation_id, panel_id, kind, output_index, holder_id,
                                       requested_by, expires_at)
    values ('d0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a',
            '20000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a', 'remote_open', 0,
            '30000000-0000-0000-0000-00000000000a', 'Caseta norte', now() + interval '10 seconds')$$,
  'una orden remote_open con su titular se crea');
select ok((select reason is null from public.panel_commands where id = 'd0000000-0000-0000-0000-00000000000a'),
  'reason empieza nulo');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'remote_open', 1, 'x', now() + interval '10 seconds')$$,
  '23514', null, 'una remote_open sin holder_id falla');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, holder_id,
                                       requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'remote_open', 1, '30000000-0000-0000-0000-00000000000c',
            'x', now() + interval '10 seconds')$$,
  '23503', null, 'el titular debe ser de la instalación de la orden');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'abrir', 1, 'x', now() + interval '10 seconds')$$,
  '23514', null, 'kind solo admite test_output o remote_open');
select lives_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 1, 'x', now() + interval '10 seconds')$$,
  'test_output sigue sin holder_id');
select throws_ok(
  $$insert into public.panel_commands (tenant_id, installation_id, panel_id, kind, output_index, requested_by, expires_at)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'c0000000-0000-0000-0000-00000000000a', 'test_output', 0, 'x', now() + interval '10 seconds')$$,
  '23505', null, 'una remote_open pendiente ocupa la salida también para test_output');
select throws_ok(
  $$update public.panel_commands set reason = 256 where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  '23514', null, 'reason va de 0 a 255');
select lives_ok(
  $$update public.panel_commands set status = 'error', reason = 3, detail = 'Sin permiso de apertura remota',
                                     finished_at = now()
     where id = 'd0000000-0000-0000-0000-00000000000a'$$,
  'el servidor guarda el motivo del resultado');
select is((select reason from public.panel_commands where id = 'd0000000-0000-0000-0000-00000000000a'), 3,
  'reason queda guardado');

select * from finish();
rollback;
