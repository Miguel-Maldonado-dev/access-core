# Borrado definitivo de datos en la nube

**Fecha:** 2026-11-23. **Aprobado** por el dueño en la conversación ("adelante con 30 días").

## Por qué
El dueño revisó la base de producción y vio que, al borrar titulares, tarjetas, controles, botones, salidas, reglas, etc., la información se queda en la base. Hoy cada borrado es **lógico** (`deleted_at`): la fila marcada sirve para que los paneles se enteren del borrado por el feed de cambios. Pero nunca se elimina, y conserva datos personales (nombres, direcciones, notas, PIN cifrado, `pin_lookup`, códigos de tarjeta y RF). `audit_log` copia esos datos en cada cambio.

## Qué se construye
1. **Vaciado inmediato al borrar** (en la base, para que aplique a cualquier camino: interfaz, API pública, push de paneles, importación, revocación):
   - Cuando una fila replicada pasa a `deleted_at` no nulo, sus columnas con datos se ponen en nulo (o en un valor neutro si la columna es `not null` y no conviene cambiar la restricción). Se conservan solo `id`, `tenant_id`, `installation_id`, las FK necesarias, `revision`, `updated_at`, `updated_by`, `origin` y `deleted_at`.
   - **Mínimo obligatorio:** titulares (nombre, departamento, dirección, notas, `pin_ciphertext`, `pin_lookup`), tarjetas (código y etiqueta), controles (descripción), botones (`rf_code`), salidas (alias), perfiles y reglas (nombre y horarios si aplica). Revisa todas las tablas replicadas y decide columna por columna. **[decisión de Claude]**
   - En `audit_log`, las entradas del registro borrado pierden sus datos personales (se quedan con tabla, id, operación, fecha y autor).
   - Los índices únicos parciales (`where deleted_at is null`) siguen funcionando: un dato borrado no bloquea volver a usar el mismo código o PIN.
2. **Eliminación definitiva a los 30 días** con un trabajo diario de `pg_cron` (por ejemplo `deleted-rows-purge`, a la misma hora que `access-logs-retention`, `'0 9 * * *'`):
   - Elimina físicamente las filas con `deleted_at` de **más de 30 días** de todas las tablas replicadas, en orden de FK. **[decisión de Claude]**: se usa solo la regla de 30 días; un panel que no sincronizó en 30 días se corrige con su reconciliación diaria, que compara todo.
   - Elimina las entradas de `audit_log` de esas filas.
   - Elimina las `panel_commands` terminadas (`status <> 'pending'`) con más de 30 días, y `log_purges` con más de 30 días si no hace falta conservarla más **[decisión de Claude]**.
   - Elimina los paneles `revoked` sin actividad en más de 30 días junto con lo que dependa de ellos; sus logs ya habrán caducado.
3. **Lo que no cambia:** el protocolo con los paneles. Hay que verificar (y probar) que un panel cuyo cursor es anterior a filas ya eliminadas se corrige: o la reconciliación del mismo ciclo lo arregla, o el feed fuerza una reconciliación. Si hace falta, la nube marca la instalación con la revisión más alta purgada y `GET /changes` lo indica de forma que el agente actual ya reconcilie (sin cambiar el paquete del panel si es posible).

## Restricciones
- Sin commits; Supabase solo local; migración nueva; RLS y funciones privilegiadas como en las migraciones anteriores.
- Los logs (`access_logs`) siguen su propia retención de 30 días; no se tocan aquí.
- La reconciliación y los checksums deben seguir cuadrando para los paneles activos.

## Implementación (decisiones de Claude)
- **[decisión de Claude]** Valores neutros al vaciar: `holders.name = '(borrado)'` (tiene check de longitud), texto `''`, códigos de tarjeta y RF en 0, máscaras y horario de reglas en 0/false, PIN en nulo. Se conservan `kind`, `button`, `local_permission_id`, `output_index`, `duration_ms`, `reader_mask` y `enabled` (no son datos personales). `holder_profiles` y `control_button_panels` no tienen datos que vaciar. `audit_log` ya no guarda datos de la fila, así que solo se eliminan sus entradas al eliminar la fila.
- **[decisión de Claude]** Las filas ya borradas se vacían en la migración desactivando solo los triggers `<tabla>_before_write` y `<tabla>_audit` (`alter table … disable trigger`), sin `session_replication_role`: sin revisión nueva ni auditoría.
- **[decisión de Claude]** Un panel revocado se elimina si su última actividad (`last_seen_at`/`last_sync_at`, o `created_at`) tiene más de 30 días y ya no quedan salidas, reglas ni vínculos que lo nombren.
- **[decisión de Claude]** Paneles con cursor viejo: `installations.purged_revision` guarda la revisión más alta eliminada; si `0 < since < purged_revision`, `GET /changes` responde `revision = since - 1` sin cambios, y el agente actual (rama "la nube va detrás") reconcilia por checksums en el mismo ciclo. Sin cambios en el paquete del panel.
- **[decisión de Claude]** Lápidas: `public.purged_rows(id, table_name, installation_id, purged_at)` sin datos personales, con RLS y sin acceso para `anon`/`authenticated`. `private.push_row` y `private.push_permission` pasan a ser envoltorios (las originales se renombran `*_base`): un alta o cambio de un id con lápida responde `superseded` y un borrado, `applied`; así un panel atrasado no revive una fila eliminada. Las lápidas **no se depuran** (solo ids, costo mínimo); revisarlo si crecen.
- **[decisión de Claude]** Conflictos e importaciones: al borrar una fila se vacían `cloud_version` y `panel_version` de sus `sync_conflicts`, y un conflicto nuevo de una fila borrada o eliminada se guarda sin versiones (trigger en `sync_conflicts`). La eliminación quita los conflictos de filas eliminadas y los revisados (`reviewed_at`) de más de 30 días; los no revisados se conservan. `panel_imports` ya se borra al confirmar o descartar; se eliminan además las de más de 30 días de paneles que ya no están en `awaiting_review` (una revisión pendiente no se rompe).
- **[decisión de Claude]** `/checksums` envía `confirm_deletions = true` mientras el último cursor de pull del panel (`synced_revision`, mayor que 0) sea menor que `purged_revision`. Es seguro porque ese panel ya no puede recibir los borrados por el feed, la reconciliación es la única vía, y la condición se apaga sola en cuanto un pull registra el cursor al día. Sin esto la guarda de borrados masivos bloquearía la reconciliación en cada ciclo. Riesgo aceptado: durante esa reconciliación tampoco se frena un borrado masivo reciente y legítimo de la nube.
- **[decisión de Claude]** La función de vaciado es `security definer` (en `private`, solo la invocan triggers) para que un borrado desde la interfaz también vacíe `sync_conflicts`.
