-- Pruebas de "Marcar como revisado" en sync_conflicts (N15): columnas, privilegios por
-- columna, RLS de UPDATE, trigger que fija reviewed_by y reviewed_at. Corren con
-- `supabase test db`.
begin;
select plan(23);

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-b@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sin-tenant@test.local');
insert into public.tenants (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'tecnico'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'admin');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Fracc B');
insert into public.panels (id, panel_code, panel_secret_hash, device_token_hash, installation_id, status) values
  ('c0000000-0000-0000-0000-00000000000a', 'PNL-AAAA-000A', repeat('2', 64), repeat('3', 64),
   '20000000-0000-0000-0000-00000000000a', 'active'),
  ('c0000000-0000-0000-0000-00000000000b', 'PNL-BBBB-000B', repeat('2', 64), repeat('4', 64),
   '20000000-0000-0000-0000-00000000000b', 'active');
insert into public.sync_conflicts (id, tenant_id, installation_id, panel_id, table_name, row_id, kind, resolution) overriding system value values
  (9001, '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 'cards', '40000000-0000-0000-0000-0000000000a1', 'unique', 'Rechazado: duplicado.'),
  (9002, '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
   'c0000000-0000-0000-0000-00000000000a', 'cards', '40000000-0000-0000-0000-0000000000a2', 'lww', 'x'),
  (9003, '10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b',
   'c0000000-0000-0000-0000-00000000000b', 'cards', '40000000-0000-0000-0000-0000000000b1', 'lww', 'x');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select has_column('public', 'sync_conflicts', 'reviewed_at', 'sync_conflicts tiene reviewed_at');
select has_column('public', 'sync_conflicts', 'reviewed_by', 'sync_conflicts tiene reviewed_by');
select col_is_null('public', 'sync_conflicts', 'reviewed_at', 'reviewed_at admite nulo (sin revisar)');
select ok(exists (
  select 1 from pg_constraint c
  where c.conrelid = 'public.sync_conflicts'::regclass and c.contype = 'f'
    and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'n'
    and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.sync_conflicts'::regclass and attname = 'reviewed_by')]::smallint[]),
  'reviewed_by referencia auth.users con on delete set null');
select has_trigger('public', 'sync_conflicts', 'sync_conflicts_review', 'existe el trigger de revision');
select ok(has_column_privilege('authenticated', 'public.sync_conflicts', 'reviewed_at', 'update'),
  'authenticated puede actualizar reviewed_at');
select ok(not has_column_privilege('authenticated', 'public.sync_conflicts', 'reviewed_by', 'update'),
  'authenticated no puede actualizar reviewed_by');
select ok(not has_column_privilege('authenticated', 'public.sync_conflicts', 'resolution', 'update'),
  'authenticated no puede actualizar resolution');
select ok(not has_column_privilege('anon', 'public.sync_conflicts', 'reviewed_at', 'update'),
  'anon no puede actualizar reviewed_at');

-- ---------------------------------------------------------------------------
-- authenticated: miembro del tenant A
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select is((select reviewed_at from public.sync_conflicts where id = 9001), null, 'el conflicto nace sin revisar');
update public.sync_conflicts set reviewed_at = '2001-01-01T00:00:00Z' where id = 9001;
select is((select reviewed_by from public.sync_conflicts where id = 9001),
  '00000000-0000-0000-0000-0000000000a1'::uuid, 'el trigger pone reviewed_by = auth.uid()');
select ok((select reviewed_at from public.sync_conflicts where id = 9001) > now() - interval '1 minute',
  'el trigger pone la hora del servidor, no la que mande el cliente');

select lives_ok($$update public.sync_conflicts set reviewed_at = null where id = 9001$$,
  'volver a escribir reviewed_at no falla');
select isnt((select reviewed_at from public.sync_conflicts where id = 9001), null,
  'una revision hecha no se deshace ni se reescribe');

select throws_ok($$update public.sync_conflicts set reviewed_by = '00000000-0000-0000-0000-0000000000b1' where id = 9002$$,
  '42501', null, 'no puede fijar reviewed_by');
select throws_ok($$update public.sync_conflicts set resolution = 'y' where id = 9002$$,
  '42501', null, 'no puede cambiar otras columnas');
select throws_ok($$update public.sync_conflicts set reviewed_at = now(), kind = 'skew' where id = 9002$$,
  '42501', null, 'no puede cambiar otras columnas junto con reviewed_at');

update public.sync_conflicts set reviewed_at = now() where id = 9003;
reset role;
select is((select reviewed_at from public.sync_conflicts where id = 9003), null,
  'un miembro del tenant A no marca conflictos del tenant B');

-- ---------------------------------------------------------------------------
-- authenticated: miembro del tenant B y usuario sin tenant
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.sync_conflicts), 1, 'el miembro de B solo ve su conflicto');
update public.sync_conflicts set reviewed_at = now() where id = 9002;
reset role;
select is((select reviewed_at from public.sync_conflicts where id = 9002), null,
  'un miembro del tenant B no marca conflictos del tenant A');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.sync_conflicts), 0, 'quien no es miembro no ve conflictos');
update public.sync_conflicts set reviewed_at = now();
reset role;
select is((select count(*)::int from public.sync_conflicts where reviewed_at is not null), 1,
  'quien no es miembro no marca nada (solo sigue marcado el de A de antes)');

set local role anon;
select throws_ok($$update public.sync_conflicts set reviewed_at = now()$$, '42501', null,
  'anon no puede marcar conflictos');
reset role;

select * from finish();
rollback;
