-- Pruebas de los lotes de la API (migración api_batch): mientras un lote está abierto, las
-- escrituras con `x-acc-batch` (service_role) reciben la revisión pendiente sin subir
-- installations.revision (sin aviso); al cerrar, sube una vez si hubo cambios.
-- Corren con `supabase test db` en el stack local.
begin;
select plan(21);

insert into public.tenants (id, name) values ('10000000-0000-0000-0000-0000000000b1', 'Tenant Lote');
insert into public.installations (id, tenant_id, name) values
  ('20000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000b1', 'Fracc Lote');

-- Estructura y permisos
select has_table('private', 'installation_batches', 'existe private.installation_batches');
select ok(
  not has_function_privilege('authenticated', 'public.api_batch_begin(uuid, uuid, int)', 'execute')
  and not has_function_privilege('anon', 'public.api_batch_begin(uuid, uuid, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.api_batch_end(uuid, uuid)', 'execute'),
  'abrir y cerrar lotes no es ejecutable por anon ni authenticated');
select ok(
  has_function_privilege('service_role', 'public.api_batch_begin(uuid, uuid, int)', 'execute')
  and has_function_privilege('service_role', 'public.api_batch_end(uuid, uuid)', 'execute'),
  'service_role abre y cierra lotes');
select is(
  (select count(*)::int from cron.job where jobname = 'api-batches-expire'), 1,
  'existe el trabajo api-batches-expire');

create temp table _rev as select revision as r0 from public.installations where id = '20000000-0000-0000-0000-0000000000b1';
grant select on _rev to public;

-- Abrir
select is(public.api_batch_begin('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b1', 60),
  true, 'abre el lote');
select is(public.api_batch_begin('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b2', 60),
  false, 'otro lote vigente en la misma instalación no se abre');

-- Escrituras del lote: service_role con el token
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{"x-acc-batch":"30000000-0000-0000-0000-0000000000b1"}', true);
insert into public.holders (id, installation_id, kind, name, updated_by, origin) values
  ('40000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b1', 'persona', 'Uno', 'prueba', 'cloud'),
  ('40000000-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000b1', 'persona', 'Dos', 'prueba', 'cloud');
update public.holders set name = 'Uno bis' where id = '40000000-0000-0000-0000-0000000000b1';

select is((select revision from public.installations where id = '20000000-0000-0000-0000-0000000000b1'),
  (select r0 from _rev), 'las escrituras del lote no suben installations.revision');
select is(
  (select array_agg(distinct revision) from public.holders where installation_id = '20000000-0000-0000-0000-0000000000b1'),
  array[(select r0 + 1 from _rev)], 'todas las filas del lote llevan la revisión pendiente');
select is((select dirty from private.installation_batches where installation_id = '20000000-0000-0000-0000-0000000000b1'),
  true, 'el lote queda con cambios');

-- Un token ajeno o un rol que no es service_role escriben como siempre
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is(private.bump_revision('20000000-0000-0000-0000-0000000000b1'), (select r0 + 1 from _rev),
  'sin service_role el encabezado se ignora y la revisión sube (publica lo del lote)');
select is((select dirty from private.installation_batches where installation_id = '20000000-0000-0000-0000-0000000000b1'),
  false, 'una escritura ajena publica el lote: queda sin cambios pendientes');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(private.bump_revision('20000000-0000-0000-0000-0000000000b1'), (select r0 + 2 from _rev),
  'el lote sigue con la nueva revisión pendiente');
select set_config('request.headers', '{"x-acc-batch":"30000000-0000-0000-0000-0000000000ff"}', true);
select is(private.bump_revision('20000000-0000-0000-0000-0000000000b1'), (select r0 + 2 from _rev),
  'con otro token la escritura es normal');
-- Supuesto: PostgREST siempre manda un objeto JSON válido; lo que no empieza con '{' se ignora.
select set_config('request.headers', 'esto no es json', true);
select lives_ok($$select private.bump_revision('20000000-0000-0000-0000-0000000000b1')$$,
  'un request.headers que no es JSON no rompe la escritura');
select set_config('request.headers', '[1]', true);
select lives_ok($$select private.bump_revision('20000000-0000-0000-0000-0000000000b1')$$,
  'un request.headers que no es objeto no rompe la escritura');
select set_config('request.headers', '{}', true);

-- Cerrar
select is(public.api_batch_end('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000ff'),
  (select r0 + 4 from _rev), 'cerrar con otro token no hace nada');
select is(public.api_batch_end('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b1'),
  (select r0 + 4 from _rev), 'cerrar sin cambios pendientes no sube la revisión');

-- Un lote con cambios sube una vez y deja un solo aviso
-- Los avisos pendientes de lo anterior se disparan antes de configurar Vault (sin efecto).
set constraints all immediate;
set constraints all deferred;
select vault.create_secret('http://app.test', 'app_url', 'lote prueba');
select vault.create_secret('secreto-de-prueba', 'internal_webhook_secret', 'lote prueba');
select public.api_batch_begin('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b3', 60);
select set_config('request.headers', '{"x-acc-batch":"30000000-0000-0000-0000-0000000000b3"}', true);
update public.holders set name = 'A' where id = '40000000-0000-0000-0000-0000000000b1';
update public.holders set name = 'B' where id = '40000000-0000-0000-0000-0000000000b2';
select set_config('request.headers', '{}', true);
set constraints all immediate;
select is((select count(*)::int from net.http_request_queue where url = 'http://app.test/api/internal/revision-changed'),
  0, 'las escrituras del lote no avisan a los paneles');
set constraints all deferred;
select is(public.api_batch_end('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b3'),
  (select r0 + 5 from _rev), 'cerrar un lote con cambios sube la revisión exactamente una vez');
set constraints all immediate;
select is((select count(*)::int from net.http_request_queue where url = 'http://app.test/api/internal/revision-changed'),
  1, 'el cierre deja un solo aviso');

-- Caducado: el trabajo lo publica
select public.api_batch_begin('20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b4', 60);
update private.installation_batches set dirty = true, expires_at = now() - interval '1 second'
where installation_id = '20000000-0000-0000-0000-0000000000b1';
select private.expire_api_batches();
select is((select revision from public.installations where id = '20000000-0000-0000-0000-0000000000b1'),
  (select r0 + 6 from _rev), 'un lote caducado con cambios se publica y se borra');

select * from finish();
rollback;
