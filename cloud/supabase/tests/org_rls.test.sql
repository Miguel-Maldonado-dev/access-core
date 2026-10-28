-- Pruebas de organización y RLS (N2). Corren con `supabase test db` en el stack local.
begin;
select plan(30);

-- Datos de prueba (como superusuario, sin RLS)
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tecnico-a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-b@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-susp@test.local'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'super@test.local'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nuevo@test.local');

insert into public.tenants (id, name, suspended_at) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A', null),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B', null),
  ('10000000-0000-0000-0000-00000000000c', 'Tenant suspendido', now());

insert into public.tenant_members (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'tecnico'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'admin'),
  ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000c1', 'admin');

insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000d1');

insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Fracc A'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Fracc B'),
  ('20000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000c', 'Fracc suspendido');

-- Restricción de nombre vacío
select throws_ok(
  $$insert into public.tenants (name) values ('   ')$$,
  '23514', null, 'tenants.name no admite nombres en blanco');

-- RLS activa en las tablas
select ok((select relrowsecurity from pg_class where oid = 'public.tenants'::regclass), 'RLS activa en tenants');
select ok((select relrowsecurity from pg_class where oid = 'public.platform_admins'::regclass), 'RLS activa en platform_admins');
select ok((select relrowsecurity from pg_class where oid = 'public.tenant_members'::regclass), 'RLS activa en tenant_members');
select ok((select relrowsecurity from pg_class where oid = 'public.installations'::regclass), 'RLS activa en installations');

-- anon no tiene acceso
set local role anon;
select throws_ok($$select * from public.installations$$, '42501', null, 'anon no puede leer installations');
select throws_ok($$select * from public.tenants$$, '42501', null, 'anon no puede leer tenants');
reset role;

-- Miembro del tenant A (admin-a)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select results_eq(
  $$select id from public.installations order by name$$,
  $$values ('20000000-0000-0000-0000-00000000000a'::uuid)$$,
  'miembro de A ve solo sus instalaciones');
select is((select count(*)::int from public.installations where tenant_id = '10000000-0000-0000-0000-00000000000b'), 0,
  'miembro de A ve 0 instalaciones de B');
select results_eq(
  $$select id from public.tenants$$,
  $$values ('10000000-0000-0000-0000-00000000000a'::uuid)$$,
  'miembro de A ve solo su tenant');
select throws_ok($$select * from public.platform_admins$$, '42501', null,
  'authenticated no accede directo a platform_admins');
select throws_ok(
  $$insert into public.tenants (name) values ('Nuevo')$$, '42501', null,
  'un miembro no puede crear tenants');
select is((select count(*)::int from public.tenant_members), 2,
  'admin de A ve los miembros de A (y no los de B)');

-- admin sí puede agregar miembros a su tenant, no al de B
select lives_ok(
  $$insert into public.tenant_members (tenant_id, user_id, role)
    values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'tecnico')$$,
  'admin de A puede insertar en tenant_members de A');
select throws_ok(
  $$insert into public.tenant_members (tenant_id, user_id, role)
    values ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e1', 'tecnico')$$,
  '42501', null, 'admin de A no puede insertar miembros en B');

-- Instalaciones: el admin crea, el miembro renombra, nadie desde authenticated borra ni toca revision
select lives_ok(
  $$insert into public.installations (tenant_id, name) values ('10000000-0000-0000-0000-00000000000a', 'Otra')$$,
  'admin puede crear instalaciones en su tenant');
select throws_ok(
  $$insert into public.installations (tenant_id, name) values ('10000000-0000-0000-0000-00000000000b', 'Intruso')$$,
  '42501', null, 'admin de A no puede crear instalaciones en otro tenant');
select throws_ok(
  $$insert into public.installations (tenant_id, name, revision) values ('10000000-0000-0000-0000-00000000000a', 'Rev', 5)$$,
  '42501', null, 'no se puede dar revision al insertar');
select lives_ok(
  $$update public.installations set name = 'Renombrada' where id = '20000000-0000-0000-0000-00000000000a'$$,
  'miembro puede renombrar su instalacion');
select is((select name from public.installations where id = '20000000-0000-0000-0000-00000000000a'), 'Renombrada',
  'el renombrado se aplico');
select throws_ok(
  $$update public.installations set revision = 99 where id = '20000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'miembro no puede escribir revision');
select throws_ok(
  $$update public.installations set tenant_id = '10000000-0000-0000-0000-00000000000b' where id = '20000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'miembro no puede mover una instalacion de tenant');
select is_empty(
  $$update public.installations set name = 'X' where id = '20000000-0000-0000-0000-00000000000b' returning id$$,
  'miembro de A no renombra instalaciones de B');
select throws_ok(
  $$delete from public.installations where id = '20000000-0000-0000-0000-00000000000a'$$,
  '42501', null, 'miembro no puede borrar instalaciones');

-- Técnico del tenant A
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $$insert into public.tenant_members (tenant_id, user_id, role)
    values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1', 'tecnico')$$,
  '42501', null, 'un tecnico no puede insertar en tenant_members');
select throws_ok(
  $$insert into public.installations (tenant_id, name) values ('10000000-0000-0000-0000-00000000000a', 'Tec')$$,
  '42501', null, 'un tecnico no puede insertar instalaciones');
select lives_ok(
  $$update public.installations set name = 'Por tecnico' where id = '20000000-0000-0000-0000-00000000000a'$$,
  'un tecnico puede renombrar');

-- Miembro de tenant suspendido
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.installations), 0, 'miembro de tenant suspendido ve 0 instalaciones');

-- platform_admin
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}';
-- Cuenta solo los tenants de esta prueba (por id): la base local puede tener otros, y el
-- súper administrador debe ver también los que no son suyos (A, B y el suspendido).
select is(
  (select count(*)::int from public.tenants
    where id in ('10000000-0000-0000-0000-00000000000a',
                 '10000000-0000-0000-0000-00000000000b',
                 '10000000-0000-0000-0000-00000000000c')),
  3, 'platform_admin ve todos los tenants');
select lives_ok(
  $$insert into public.tenants (name) values ('Creado por super')$$, 'platform_admin puede crear tenants');

reset role;
select * from finish();
rollback;
