-- Pruebas de la regla "al menos un administrador" y de las búsquedas en auth.users (N11).
-- Corren con `supabase test db` en el stack local. Como postgres, auth.uid() es nulo.
begin;
select plan(30);

-- ---------------------------------------------------------------------------
-- Datos base
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a1@test.local', now()),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a2@test.local', now()),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-a3@test.local', null),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-b1@test.local', now()),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-c1@test.local', now()),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-d1@test.local', now()),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-d2@test.local', now());

insert into public.tenants (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B'),
  ('10000000-0000-0000-0000-00000000000c', 'Tenant C'),
  ('10000000-0000-0000-0000-00000000000d', 'Tenant D');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'tecnico'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'admin'),
  ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000c1', 'admin'),
  ('10000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d1', 'admin'),
  ('10000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d2', 'tecnico');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select has_trigger('public', 'tenant_members', 'tenant_members_keep_admin',
  'tenant_members tiene el trigger de último administrador');
select is(
  (select prosecdef from pg_proc where oid = 'private.tenant_members_keep_admin()'::regprocedure),
  true, 'la función del trigger es security definer (bloquea el tenant aunque RLS no lo deje ver)');
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc
    where oid = 'private.tenant_members_keep_admin()'::regprocedure),
  'la función del trigger fija search_path vacío');

-- ---------------------------------------------------------------------------
-- Quitar y degradar administradores (como servidor)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$delete from public.tenant_members
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a2'$$,
  'se puede quitar a un admin si queda otro');
select throws_ok(
  $$delete from public.tenant_members
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'quitar al último admin falla');
select throws_ok(
  $$update public.tenant_members set role = 'tecnico'
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'degradar al último admin falla');
select throws_ok(
  $$update public.tenant_members set tenant_id = '10000000-0000-0000-0000-00000000000b'
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'mover al último admin a otro tenant falla');
select is(
  (select role from public.tenant_members
    where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a1'),
  'admin', 'tras los intentos fallidos el último admin sigue siéndolo');

select lives_ok(
  $$update public.tenant_members set role = 'admin'
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a3'$$,
  'promover a un técnico no se restringe');
select lives_ok(
  $$update public.tenant_members set role = 'tecnico'
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  'degradar a un admin cuando hay otro sí se puede');
select lives_ok(
  $$update public.tenant_members set role = 'admin'
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a3'$$,
  'reasignar el mismo rol de admin no se restringe');
select lives_ok(
  $$update public.tenant_members set role = 'admin'
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  'volver a promover a a1');
select throws_ok(
  $$delete from public.tenant_members
     where tenant_id = '10000000-0000-0000-0000-00000000000a' and role = 'admin'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'quitar a todos los admins en una sola sentencia falla');
select throws_ok(
  $$update public.tenant_members set role = 'tecnico'
     where tenant_id = '10000000-0000-0000-0000-00000000000a'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'degradar a todos los admins en una sola sentencia falla');
select is(
  (select count(*)::int from public.tenant_members
    where tenant_id = '10000000-0000-0000-0000-00000000000a' and role = 'admin'),
  2, 'las sentencias fallidas no cambiaron nada');

select lives_ok(
  $$delete from public.tenant_members
     where tenant_id = '10000000-0000-0000-0000-00000000000d' and user_id = '00000000-0000-0000-0000-0000000000d2'$$,
  'quitar a un técnico no se restringe');
select lives_ok(
  $$insert into public.tenant_members (tenant_id, user_id, role)
    values ('10000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000d2', 'tecnico')$$,
  'agregar miembros no se restringe');

-- ---------------------------------------------------------------------------
-- Borrados en cascada
-- ---------------------------------------------------------------------------
select lives_ok(
  $$delete from public.tenants where id = '10000000-0000-0000-0000-00000000000c'$$,
  'borrar un tenant borra en cascada a su único admin');
select is(
  (select count(*)::int from public.tenant_members where tenant_id = '10000000-0000-0000-0000-00000000000c'),
  0, 'el tenant borrado ya no tiene miembros');
select throws_ok(
  $$delete from auth.users where id = '00000000-0000-0000-0000-0000000000d1'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'borrar en Auth al último admin de un tenant vivo falla');
select lives_ok(
  $$delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1'$$,
  'borrar en Auth a un admin que no es el último sí se puede');

-- ---------------------------------------------------------------------------
-- Como admin del tenant (con RLS)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok(
  $$delete from public.tenant_members
     where tenant_id = '10000000-0000-0000-0000-00000000000b' and user_id = '00000000-0000-0000-0000-0000000000b1'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'el último admin no puede quitarse a sí mismo');
select throws_ok(
  $$update public.tenant_members set role = 'tecnico'
     where tenant_id = '10000000-0000-0000-0000-00000000000b' and user_id = '00000000-0000-0000-0000-0000000000b1'$$,
  '23514', 'El tenant debe tener al menos un administrador.',
  'el último admin no puede degradarse a sí mismo');

-- Búsquedas en auth.users: solo con la llave secreta
select throws_ok($$select public.auth_user_id_by_email('admin-b1@test.local')$$, '42501', null,
  'authenticated no puede buscar usuarios por correo');
select throws_ok($$select * from public.auth_user_emails(array['00000000-0000-0000-0000-0000000000b1'::uuid])$$,
  '42501', null, 'authenticated no puede leer correos de Auth');
reset role;

set local role anon;
select throws_ok($$select public.auth_user_id_by_email('admin-b1@test.local')$$, '42501', null,
  'anon no puede buscar usuarios por correo');
reset role;

set local role service_role;
select is(public.auth_user_id_by_email('  Admin-B1@Test.Local '), '00000000-0000-0000-0000-0000000000b1'::uuid,
  'la búsqueda por correo ignora mayúsculas y espacios');
select is(public.auth_user_id_by_email('nadie@test.local'), null::uuid,
  'un correo sin cuenta devuelve null');
select results_eq(
  $$select user_id, email, email_confirmed from public.auth_user_emails(array[
      '00000000-0000-0000-0000-0000000000b1'::uuid, '00000000-0000-0000-0000-0000000000a3'::uuid]) order by email$$,
  $$values ('00000000-0000-0000-0000-0000000000b1'::uuid, 'admin-b1@test.local'::text, true),
           ('00000000-0000-0000-0000-0000000000a3'::uuid, 'tecnico-a3@test.local'::text, false)$$,
  'auth_user_emails devuelve correo y confirmación de los ids pedidos');
select is(
  (select count(*)::int from public.auth_user_emails(array['00000000-0000-0000-0000-0000000000ff'::uuid])),
  0, 'un id inexistente no devuelve filas');
reset role;

select * from finish();
rollback;
