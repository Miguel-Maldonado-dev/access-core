-- conflicts_review: "Marcar como revisado" en la lista de conflictos de sincronización (N15).
--
-- Un conflicto sigue en la lista después de revisarse: solo cambia su estado. El miembro del
-- tenant (admin o técnico) puede escribir ÚNICAMENTE reviewed_at; la hora y el autor los
-- decide el servidor con un trigger, así que el cliente no puede falsificarlos.

alter table public.sync_conflicts
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users (id) on delete set null;

-- Borrar un usuario de Auth pone reviewed_by en nulo: sin índice buscaría en toda la tabla.
create index sync_conflicts_reviewed_by_idx on public.sync_conflicts (reviewed_by)
  where reviewed_by is not null;

-- Solo reviewed_at: ni resolution, ni kind, ni reviewed_by (lo fija el trigger).
grant update (reviewed_at) on public.sync_conflicts to authenticated;

create policy sync_conflicts_review on public.sync_conflicts for update to authenticated
  using ((select private.is_member(tenant_id)))
  with check ((select private.is_member(tenant_id)));

-- BEFORE UPDATE OF reviewed_at. Corre con los privilegios de quien escribe (no necesita
-- security definer: solo toca NEW y lee auth.uid()). Reglas:
--   - la revisión es de un solo sentido: si ya estaba revisado, conserva la hora y el autor
--     originales (repetir la acción o mandar null no la deshace ni la reescribe);
--   - si no lo estaba, y llega un valor, fija la hora del servidor y reviewed_by = auth.uid();
--   - null sobre un conflicto sin revisar no hace nada.
create function private.sync_conflicts_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.reviewed_at is not null then
    new.reviewed_at := old.reviewed_at;
    new.reviewed_by := old.reviewed_by;
  elsif new.reviewed_at is not null then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  else
    new.reviewed_by := null;
  end if;
  return new;
end;
$$;

revoke execute on function private.sync_conflicts_review() from public;

create trigger sync_conflicts_review
  before update of reviewed_at on public.sync_conflicts
  for each row execute function private.sync_conflicts_review();
