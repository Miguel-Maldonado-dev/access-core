-- 0005_notify: avisos de cambio de revisión (nube -> paneles por MQTT) y estado en línea (N10).
--
-- 1) panels.online_event_at: marca de tiempo del último evento de conexión aplicado
--    (la del evento de EMQX, no la de llegada). /api/mqtt/events ignora los eventos más
--    viejos, para que una desconexión tardía no deje fuera de línea a un panel reconectado.
-- 2) Aviso: cuando cambia installations.revision, al confirmar la transacción se llama con
--    pg_net a ${APP_URL}/api/internal/revision-changed; la aplicación publica por MQTT a
--    cada panel activo. Un solo aviso por instalación por transacción.
--
-- Configuración en Supabase Vault (secretos con estos nombres exactos):
--   app_url                   URL pública de la aplicación, sin barra final (APP_URL).
--   internal_webhook_secret   mismo valor que INTERNAL_WEBHOOK_SECRET de la aplicación.
-- Alta (una vez por proyecto, en el editor SQL):
--   select vault.create_secret('https://app.ejemplo.com', 'app_url');
--   select vault.create_secret('<secreto>', 'internal_webhook_secret');
-- Si falta alguno, el aviso no hace nada y no falla (las escrituras siguen funcionando).

-- pg_net envía las peticiones HTTP de forma asíncrona (Access-Core-DEV no lo trae instalado).
create extension if not exists pg_net with schema extensions;

alter table public.panels add column online_event_at timestamptz;

-- security definer: lee Vault, que el rol que escribe (authenticated o service_role) no ve.
create function private.notify_revision_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Un GUC personalizado solo admite identificadores simples: el uuid va sin guiones.
  v_marca text := 'acc.notified_' || replace(new.id::text, '-', '');
  v_url text;
  v_secreto text;
  v_revision bigint;
begin
  -- Ya se avisó de esta instalación en esta transacción.
  if current_setting(v_marca, true) = '1' then
    return null;
  end if;

  select ds.decrypted_secret into v_url
  from vault.decrypted_secrets ds where ds.name = 'app_url' limit 1;
  select ds.decrypted_secret into v_secreto
  from vault.decrypted_secrets ds where ds.name = 'internal_webhook_secret' limit 1;
  if coalesce(v_url, '') = '' or coalesce(v_secreto, '') = '' then
    return null;
  end if;

  perform set_config(v_marca, '1', true);
  -- Disparado al confirmar: lleva la revisión final de la transacción.
  select i.revision into v_revision from public.installations i where i.id = new.id;

  -- Un aviso perdido nunca debe abortar la transacción de datos: la sincronización
  -- periódica del panel lo cubre. El mensaje no incluye la URL ni el secreto.
  begin
    perform net.http_post(
      url := rtrim(v_url, '/') || '/api/internal/revision-changed',
      body := jsonb_build_object('installation_id', new.id, 'revision', v_revision),
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-internal-secret', v_secreto
      )
    );
  exception when others then
    raise warning 'No se pudo encolar el aviso de revisión de la instalación % (SQLSTATE %).', new.id, sqlstate;
  end;
  return null;
end;
$$;

revoke execute on function private.notify_revision_changed() from public, anon, authenticated;

create constraint trigger installations_notify_revision
  after update of revision on public.installations
  deferrable initially deferred
  for each row
  when (old.revision is distinct from new.revision)
  execute function private.notify_revision_changed();
