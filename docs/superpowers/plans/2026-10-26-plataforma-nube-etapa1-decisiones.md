# Etapa 1 de la plataforma en la nube: decisiones de Claude

Decisiones que Claude tomó durante la implementación del plan `2026-10-26-plataforma-nube-etapa1.md` (del 2026-10-26 al 2026-10-28) sin que el dueño las fijara. Cada una dice qué se decidió, por qué y qué cuesta si resulta equivocada. Están en el orden en que se tomaron.

## Proceso y entorno

1. **Rama `develop`, sin commits ni merges de Claude.** Los pasos "commit" del plan pasaron a "dejar sin confirmar". Es la regla del dueño.
2. **`cloud/` vive dentro de `access-core`** (N1 no hace `git init`). Costo: ninguno.
3. **Las pruebas solo corren contra Supabase local.** Access-Core-DEV es el entorno remoto y recibe las migraciones después de la revisión. Costo: para probar contra DEV hace falta otro mecanismo.
4. **Las migraciones se crean con `supabase migration new`**, con nombres con fecha. Costo: ninguno.
5. **Las migraciones se aplican a DEV en bloque** y no una por una, para que DEV no quede distinto de los archivos. Costo: DEV sin datos mientras tanto. *Estado: en DEV están aplicadas `org`, `replicated` y `panels`; las demás esperan la decisión del dueño.*
6. **La revisión final se dividió en dos revisores en paralelo** (nube y panel), porque el diff total pesa unos 1.5 MB. Costo: algo de duplicación al revisar el contrato.

## Supabase y seguridad (nube)

7. **Llaves nuevas `publishable`/`secret`** en lugar de `anon`/`service_role`. Costo si es incorrecto: renombrar 2 variables.
8. **`GRANT` explícitos a `authenticated` con RLS** en cada tabla de la interfaz, y nunca a `anon`. Costo: permisos de más o de menos, que las pruebas detectan.
9. **Funciones `security definer` en el esquema `private`** con `search_path=''`. Costo: ninguno.
10. **`installations`:** solo el admin del tenant da de alta; los miembros solo cambian `name`; `revision` nunca la escribe `authenticated`; la interfaz no tiene borrado. Costo: habilitar más con un grant.
11. **`bump_revision` es `security definer` en `private`.** Costo: ninguno.
12. **`authenticated` no puede leer `pin_ciphertext` ni `pin_lookup`.** Se expone `has_pin` (columna generada) y el PIN lo descifra el servidor solo para el admin. Costo: las consultas listan columnas explícitas.
13. **Las referencias entre tablas replicadas son de la misma instalación** (FK compuestas). Costo: ninguno.
14. **Una fila viva no puede apuntar a un padre borrado:** el cambio del panel se rechaza con la versión de la nube. Costo: un cambio hecho sin conexión no "revive" al padre.
15. **Columnas de vínculo no actualizables:** cambiar un vínculo es borrar más dar de alta. Costo: la interfaz de perfiles trabaja así.
16. **`authenticated` no puede leer los hashes del panel** (código de vinculación, secreto y token). Costo: ninguno.
17. **Límite de 10 intentos fallidos de vinculación por tenant y por hora**, guardado en una tabla. Costo: una tabla.
18. **Reclamar un panel en otra instalación borra lógicamente sus salidas y reglas en la instalación anterior.** Costo: la instalación vieja pierde la configuración de salidas de un panel que ya no tiene.
19. **Las salidas y reglas que se borran al reclamar quedan firmadas como `system:reclamo`** y no con el usuario del otro tenant (corrección de la revisión final).
20. **Revocar un panel borra su importación pendiente** (`panel_imports`, con nombres y PIN cifrados).
21. **El broker MQTT rechaza un `clientid` distinto del `panel_code`**, para que un panel no pueda desconectar a otro.
22. **`/api/mqtt/auth` exige el encabezado `x-emqx-secret`.** Costo: una línea de configuración en EMQX.
23. **`/api/mqtt/events` ignora eventos más viejos que el último aplicado.** Costo: una columna.
24. **El aviso por `pg_net` nunca aborta una escritura**, y no hace nada si Vault no tiene `app_url` ni el secreto. Costo: un aviso perdido, que cubre la sincronización periódica.
25. **El primer súper administrador se crea por SQL documentado**; no hay endpoint. Costo: un paso manual.
26. **La regla "al menos un administrador" la hace cumplir un trigger** en `tenant_members`. Costo: un trigger.
27. **La página 403 responde HTTP 200** (con `noindex`) bajo Cache Components; el contenido protegido nunca se genera. Costo: un 403 HTTP real requeriría autorizar en el proxy.

## Cuentas (cambio pedido por el dueño, T1)

28. **Ya no hay invitaciones en ninguna parte.** El alta de tenant, "Agregar administrador" y los usuarios del tenant crean la cuenta con correo y contraseña, ya confirmada. Solo queda el correo de recuperación de contraseña. *Reemplaza las decisiones anteriores de N11 sobre aceptar y reenviar invitaciones.*
29. **La contraseña mínima es de 8 caracteres**, como en `/contrasena`. Costo: ninguno.
30. **Un correo con cuenta confirmada conserva su contraseña**: solo se le agrega la membresía. Costo: si el súper admin quería fijarla, la persona usa "¿Olvidaste tu contraseña?".
31. **Una cuenta sin confirmar solo se activa** si no pertenece a ningún tenant ni es súper administradora, o si la da de alta el súper administrador. Costo: con cuentas pendientes heredadas hay que pedírselo al súper admin.
32. **No se obliga a cambiar la contraseña en el primer inicio de sesión.** Costo: agregarlo después.

## Interfaz de la nube

33. **El técnico puede asignar o quitar un PIN, pero nunca verlo**; el admin lo ve al editar. Costo: ninguno.
34. **Editar un control no es atómico** en la etapa 1: se valida todo antes de escribir. Costo: mover la edición a una función SQL si hace falta.
35. **Los perfiles se asignan a los titulares desde la página de Perfiles.** Costo: moverlo al formulario del titular.
36. **La página de Salidas solo edita** alias, duración, lectores y si está habilitada; no crea ni borra salidas. Costo: ninguno.
37. **"Marcar como revisado" agregó una migración** (`conflicts_review`): es de un solo sentido y la fecha la pone el servidor. Costo: no se puede desmarcar un conflicto.
38. **Las etiquetas de logs se copiaron del panel local a la nube.** Costo: duplicación.

## API de dispositivos y sincronización (nube)

39. **Los hashes son sha256 del texto UTF-8 tal como viaja.** Costo: ninguno.
40. **`/link-state` nunca responde "revoked":** un panel revocado recibe un 401.
41. **`/changes`, `/checksums`, `/snapshot`, `/logs` y `/alerts` exigen el panel en estado `active`.** Costo: relajar una condición.
42. **El pull es consistente:** lee primero la revisión de la instalación y solo entrega lo confirmado hasta ahí. Costo si es incorrecto: cambios saltados o repetidos.
43. **El JSON canónico del checksum es idéntico al de Python** (`sort_keys`, sin espacios, `ensure_ascii=False`).
44. **Cada cambio del panel se aplica en una función SQL transaccional** (por RPC con la llave secreta). Costo: mover lógica entre Node y SQL.
45. **Un borrado de la nube es definitivo:** una edición del panel sobre un registro borrado queda como conflicto. Costo: esa edición se pierde (queda en `sync_conflicts`).
46. **Cada transacción bloquea primero la instalación** y se reintenta ante un interbloqueo. Costo: ninguno.
47. **El snapshot de importación guarda el PIN cifrado**, nunca en claro.
48. **"Instalación sin datos" = sin titulares, tarjetas, controles ni perfiles vivos.** Costo: una revisión de importación de más o de menos.
49. **La importación es atómica** y borra el snapshot al confirmar. Costo: no queda para auditoría.
50. **Al importar, los perfiles nuevos se asignan también a los titulares emparejados** que tenían ese permiso en el panel ("nadie se queda afuera"). Costo: asignaciones de más, visibles y editables.
51. **Se rechaza el carácter NUL en textos**, para que un dato no atasque la sincronización.
52. **Los logs no tienen FK a titulares ni controles** (son copias históricas) y un log de PIN nunca lleva código.
53. **Un UUID que ya existe en otra instalación recibe uno nuevo en la nube**, y el panel lo adopta.

## Panel: esquema, agente y página "Nube"

54. **Al rechazo "relacionado no existe" el panel vuelve a encolar el cambio** y conserva la fila. Cada fila se envía en la posición de su última entrada. Costo: un rechazo permanente se reintenta hasta que el pull lo resuelva.
55. **Al adoptar los datos de la nube se conservan los valores locales de las salidas**, con el UUID de la nube.
56. **Un 409 de `import-snapshot` se resuelve consultando `link-state`.**
57. **El pull no pisa filas con cambios locales pendientes**, salvo los borrados (ver 63). Costo: una fila puede ir un ciclo detrás.
58. **En un choque de PIN, al otro titular solo se le quita el PIN**; no se borra con sus tarjetas.
59. **Si liberar una llave única toca una fila pendiente, gana la nube** para esa fila y se descarta la edición local, que habría chocado de todos modos.
60. **Se aplican altas y cambios antes que borrados**, para que ninguna cascada borre lo que la nube conserva.
61. **Un alta de la nube cuyo padre no existe detiene el pull** en vez de omitirse en silencio. En los `current` del push, en cambio, se omite y llega con el siguiente pull. Costo: un panel deja de bajar cambios hasta que se corrija la nube.
62. **Un titular nuevo cuyo PIN ya existe en la nube se queda sin PIN y se vuelve a encolar**; no se borra con sus hijos.
63. **Un borrado de la nube se aplica en el pull aunque la fila tenga cambios pendientes**, para que una tarjeta revocada no siga abriendo. En la reconciliación no, porque ahí no se distingue un borrado de un alta local. Costo: una edición local sobre una fila borrada en la nube se pierde.
64. **Solo un 401 con código `unauthorized` desvincula el panel**; un 401 de un proxy o un portal cautivo se trata como error de red.
65. **Si el panel ya se activó y perdió su credencial**, avisa que hay que desvincularlo y volver a vincularlo; no puede recuperarla solo.
66. **Push, pull y subida de logs fallan por separado** dentro de cada ciclo. Costo: ninguno.
67. **Un bloqueo por borrado masivo o un lote inconsistente se anota y se reintenta**; el agente no confirma borrados masivos en la etapa 1. Costo: hay que intervenir a mano.
68. **La fecha de la última reconciliación se guarda en la base**, así que los reinicios no la posponen.
69. **El respaldo de la adopción se hace una sola vez**, después de descargar, para no desgastar la SD.
70. **La identidad del panel solo la genera el agente**; la página "Nube" avisa si aún no existe.
71. **El aviso de "perfil de la instalación" al borrar un permiso solo sale con el panel `active`.**
72. **`SYNC_INTERVAL_S` se puede ajustar por entorno**, con 300 por omisión.

## Infraestructura y prueba de punta a punta

73. **Se corrigió `cloud/infra/emqx`:** no arrancaba en EMQX 5.8.6. Ahora usa una plantilla que se renderiza dentro del contenedor, rechaza valores con caracteres de control, deja la API en `127.0.0.1` y el archivo renderizado en 0600. El E2E usa esa misma configuración.

## Cambios fuera del plan pedidos por errores en la Mac (2026-10-28)

74. **`await connection()` al crear el cliente de Supabase con sesión**, por el error de Cache Components con `Date.now()` en las páginas de instalación. Hay una alternativa opcional: `io()` de `next/cache`.
75. **Next.js del panel local actualizado de 16.4.0 a 16.4.3**, por tres vulnerabilidades de 16.4.0. No afectan a la placa, que solo sirve archivos estáticos.

## Pendientes menores que se dejaron para después

- **Cascada en el pull:** un hijo que la nube movió en un pull anterior, y que se omitió por estar pendiente, puede perderse al forzar el borrado de su padre, hasta la siguiente reconciliación. Falla hacia menos acceso.
- **Vuelta atrás de v6:** detener también `acceso-daemon` y `acceso-web`, o no reiniciar antes de reinstalar el paquete anterior.
- **`despliegue.md`:** documentar el orden. Primero va `emqx.conf` (con `clientid`) y después la app nueva. La migración `20261028165920_claim_panel_neutral_author.sql` va junto con la app.
- **`cloud/supabase/tests/logs.test.sql`:** la prueba 11 cuenta todos los logs y falla con datos reales en la base local.
- **`revokePanelAs`:** hay una ventana mínima en la que puede quedar un `panel_imports` huérfano.
- Los demás menores de cada tarea y su clasificación están en las revisiones finales (`.superpowers/sdd/2026-10-26-plataforma-nube-etapa1/final-review-{cloud,panel}.md`, carpeta ignorada por git que se conserva hasta que el dueño confirme los commits).
