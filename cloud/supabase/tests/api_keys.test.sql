-- Pruebas de llaves de API, registro de peticiones e idempotencia (API pública, etapa 2a).
-- Corren con `supabase test db` en el stack local. Como postgres, auth.uid() es nulo:
-- equivale a una escritura del servidor (llave secreta).
begin;
select plan(30);

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

insert into public.api_keys (id, tenant_id, name, prefix, key_hash, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Llave A', 'acc_aaaaaaaa',
   repeat('a', 64), '00000000-0000-0000-0000-0000000000a1'),
  ('a0000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Llave B', 'acc_bbbbbbbb',
   repeat('b', 64), '00000000-0000-0000-0000-0000000000b1');
insert into public.api_requests (key_id) values ('a0000000-0000-0000-0000-00000000000a');
insert into public.api_idempotency (key_id, idem_key, request_hash) values
  ('a0000000-0000-0000-0000-00000000000a', 'k1', repeat('c', 64));

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.api_keys'::regclass), 'RLS activa en api_keys');
select ok((select relrowsecurity from pg_class where oid = 'public.api_requests'::regclass), 'RLS activa en api_requests');
select ok((select relrowsecurity from pg_class where oid = 'public.api_idempotency'::regclass),
  'RLS activa en api_idempotency');
select columns_are('public', 'api_keys',
  array['id', 'tenant_id', 'name', 'prefix', 'key_hash', 'created_at', 'created_by', 'last_used_at', 'revoked_at'],
  'api_keys tiene exactamente las columnas del contrato');
select col_is_pk('public', 'api_idempotency', array['key_id', 'idem_key'], 'api_idempotency: pk (key_id, idem_key)');
select fk_ok('public', 'api_requests', array['key_id'], 'public', 'api_keys', array['id'], 'api_requests.key_id es FK');
select has_index('public', 'api_requests', 'api_requests_key_id_at_idx', array['key_id', 'at'],
  'api_requests tiene índice (key_id, at)');

-- ---------------------------------------------------------------------------
-- Restricciones (escrituras del servidor)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.api_keys (tenant_id, name, prefix, key_hash)
    values ('10000000-0000-0000-0000-00000000000a', '', 'acc_x', repeat('d', 64))$$,
  '23514', null, 'el nombre vacío se rechaza');
select throws_ok(
  $$insert into public.api_keys (tenant_id, name, prefix, key_hash)
    values ('10000000-0000-0000-0000-00000000000a', repeat('n', 61), 'acc_x', repeat('d', 64))$$,
  '23514', null, 'un nombre de más de 60 caracteres se rechaza');
select throws_ok(
  $$insert into public.api_keys (tenant_id, name, prefix, key_hash)
    values ('10000000-0000-0000-0000-00000000000a', 'X', 'acc_x', repeat('D', 64))$$,
  '23514', null, 'key_hash debe ser sha256 hexadecimal en minúsculas');
select throws_ok(
  $$insert into public.api_keys (tenant_id, name, prefix, key_hash)
    values ('10000000-0000-0000-0000-00000000000b', 'X', 'acc_x', repeat('a', 64))$$,
  '23505', null, 'key_hash es único');

-- ---------------------------------------------------------------------------
-- Funciones: límite de 10 llaves vivas y rotación atómica
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select public.create_api_key('10000000-0000-0000-0000-00000000000a', 'Llave ' || g, 'acc_' || g,
      lpad(to_hex(g), 64, '0'), null)
    from generate_series(1, 9) g$$,
  'create_api_key crea hasta 10 llaves vivas');
select throws_ok(
  $$select public.create_api_key('10000000-0000-0000-0000-00000000000a', 'Once', 'acc_once',
      lpad(to_hex(11), 64, 'e'), null)$$,
  'P0001', 'api_key_limit', 'la llave número 11 se rechaza');
select is(
  (select name from public.rotate_api_key('10000000-0000-0000-0000-00000000000a',
     'a0000000-0000-0000-0000-00000000000a', 'acc_rotada', repeat('f', 64), null)),
  'Llave A', 'rotate_api_key crea una llave con el mismo nombre aunque haya 10 vivas');
select isnt(
  (select revoked_at from public.api_keys where id = 'a0000000-0000-0000-0000-00000000000a'),
  null, 'rotate_api_key revoca la anterior');
select is(
  (select count(*)::int from public.rotate_api_key('10000000-0000-0000-0000-00000000000b',
     'a0000000-0000-0000-0000-00000000000a', 'acc_otra', repeat('9', 64), null)),
  0, 'rotate_api_key no rota una llave de otro tenant ni una revocada');

-- ---------------------------------------------------------------------------
-- Permisos de authenticated
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(
  (select count(*)::int from public.api_keys),
  11, 'el admin del tenant A ve las llaves de su tenant (y no las del B)');
select is(
  (select name from public.api_keys where prefix = 'acc_rotada'),
  'Llave A', 'el admin lee las columnas visibles');
select throws_ok($$select key_hash from public.api_keys$$, '42501', null, 'el admin no puede leer key_hash');
select throws_ok($$select * from public.api_keys$$, '42501', null, 'select * falla por key_hash');
select throws_ok(
  $$insert into public.api_keys (tenant_id, name, prefix, key_hash)
    values ('10000000-0000-0000-0000-00000000000a', 'X', 'acc_x', repeat('7', 64))$$,
  '42501', null, 'authenticated no inserta en api_keys');
select throws_ok(
  $$update public.api_keys set revoked_at = now()$$, '42501', null, 'authenticated no actualiza api_keys');
select throws_ok(
  $$insert into public.api_requests (key_id) values ('a0000000-0000-0000-0000-00000000000a')$$,
  '42501', null, 'authenticated no inserta en api_requests');
select throws_ok(
  $$insert into public.api_idempotency (key_id, idem_key, request_hash)
    values ('a0000000-0000-0000-0000-00000000000a', 'k2', 'x')$$,
  '42501', null, 'authenticated no inserta en api_idempotency');
select throws_ok($$select * from public.api_requests$$, '42501', null, 'authenticated no lee api_requests');
select throws_ok($$select * from public.api_idempotency$$, '42501', null, 'authenticated no lee api_idempotency');
select throws_ok(
  $$select public.create_api_key('10000000-0000-0000-0000-00000000000a', 'X', 'acc_x', repeat('6', 64), null)$$,
  '42501', null, 'authenticated no ejecuta create_api_key');
select throws_ok(
  $$select public.rotate_api_key('10000000-0000-0000-0000-00000000000a',
      'a0000000-0000-0000-0000-00000000000a', 'acc_x', repeat('6', 64), null)$$,
  '42501', null, 'authenticated no ejecuta rotate_api_key');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is((select count(*)::int from public.api_keys), 0, 'un técnico no ve las llaves');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is(
  (select count(*)::int from public.api_keys where tenant_id = '10000000-0000-0000-0000-00000000000a'),
  0, 'el admin de otro tenant no ve las llaves del tenant A');

select * from finish();
rollback;
