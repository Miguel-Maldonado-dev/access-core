-- Pruebas del aviso de cambio de revisión (N10): un solo aviso por instalación por
-- transacción, y ninguno (sin fallar) si Vault no tiene la configuración.
-- Corren con `supabase test db` en el stack local.
begin;
select plan(10);

insert into public.tenants (id, name) values ('10000000-0000-0000-0000-0000000000f1', 'Tenant N');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-0000000000f1', 'Fracc N1'),
  ('20000000-0000-0000-0000-0000000000f2', '10000000-0000-0000-0000-0000000000f1', 'Fracc N2');

-- Estructura
select has_column('public', 'panels', 'online_event_at', 'panels guarda la marca del último evento de conexión');
select ok(
  not has_function_privilege('anon', 'private.notify_revision_changed()', 'execute')
  and not has_function_privilege('authenticated', 'private.notify_revision_changed()', 'execute'),
  'la función del aviso no es ejecutable por anon ni authenticated');

create temp table _antes as
select count(*) as n from net.http_request_queue where url like '%/api/internal/revision-changed';
grant select on _antes to public;

-- Sin secretos en Vault: no hace nada y no falla
select lives_ok(
  $$update public.installations set revision = revision + 1 where id = '20000000-0000-0000-0000-0000000000f1'$$,
  'sin Vault configurado, escribir la revisión no falla');
set constraints all immediate;
select is(
  (select count(*) from net.http_request_queue where url like '%/api/internal/revision-changed')
    - (select n from _antes),
  0::bigint, 'sin Vault configurado no se encola ningún aviso');

-- Con secretos en Vault
select vault.create_secret('http://app.test', 'app_url', 'N10 prueba');
select vault.create_secret('secreto-de-prueba', 'internal_webhook_secret', 'N10 prueba');

set constraints all deferred;
update public.installations set revision = revision + 1 where id = '20000000-0000-0000-0000-0000000000f1';
update public.installations set revision = revision + 1 where id = '20000000-0000-0000-0000-0000000000f1';
update public.installations set revision = revision + 1 where id = '20000000-0000-0000-0000-0000000000f1';
set constraints all immediate;
select is(
  (select count(*) from net.http_request_queue where url = 'http://app.test/api/internal/revision-changed')
    , 1::bigint, '3 escrituras de la misma instalación dejan 1 sola petición');
select is(
  (select convert_from(body, 'utf8')::jsonb ->> 'installation_id' from net.http_request_queue
    where url = 'http://app.test/api/internal/revision-changed'),
  '20000000-0000-0000-0000-0000000000f1', 'la petición lleva el installation_id');
select is(
  (select (convert_from(body, 'utf8')::jsonb ->> 'revision')::bigint from net.http_request_queue
    where url = 'http://app.test/api/internal/revision-changed'),
  (select revision from public.installations where id = '20000000-0000-0000-0000-0000000000f1'),
  'la petición lleva la revisión final');
select is(
  (select headers ->> 'x-internal-secret' from net.http_request_queue
    where url = 'http://app.test/api/internal/revision-changed'),
  'secreto-de-prueba', 'la petición lleva el secreto interno');

-- Un fallo de net.http_post (app_url inválido) no aborta la transacción de datos
select vault.update_secret((select id from vault.secrets where name = 'app_url'), 'esto no es una url');
set constraints all deferred;
select lives_ok(
  $$update public.installations set revision = revision + 1 where id = '20000000-0000-0000-0000-0000000000f2';
    set constraints all immediate$$,
  'un fallo al encolar el aviso no aborta la escritura');
select is(
  (select revision from public.installations where id = '20000000-0000-0000-0000-0000000000f2'),
  1::bigint, 'la escritura de la instalación se conservó pese al fallo del aviso');

select * from finish();
rollback;
