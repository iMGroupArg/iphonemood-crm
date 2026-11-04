# Red de agentes de iPhoneMood: puesta en marcha

Seis agentes (`.claude/agents/`) que corren solos en la nube con agenda fija. Siguen las recetas de `.claude/skills/` y hablan con la base sólo a través de `agentes/mesa.mjs`. Franco decide todo lo importante desde **CRM → Agentes**.

```
 Rutinas en la nube ──► mesa.mjs (ventanilla con clave) ──► Supabase: agente_propuestas / bitácora / directivas / pauta_config
        │                                                              │
        └── Codex (segunda opinión)                     CRM → Agentes: Franco aprueba / rechaza / edita
                                                                       │
                                     Fase 2: ejecutor (código fijo) publica en Instagram y Meta Ads lo aprobado
```

## Fase 0: lo que hace Franco una sola vez

1. **Correr el script 26** en Supabase → SQL Editor: `db/para-correr/26_agentes.sql`. El final tiene que mostrar los 12 controles en ✅. Si aborta con FUNCIONES_SIN_CERRAR, no se instaló nada: avisar.
2. **Generar las dos claves de la ventanilla.** Los agentes NO se conectan a la base: en Supabase el esquema `net` (pedidos a internet) no se puede cerrar, así que el script 26 les saca a los usuarios de base de los agentes el permiso de entrar y cualquier contraseña vieja, y corta las conexiones que hubieran quedado abiertas (control 26.11). **No hay que darles contraseña nunca.** En el SQL Editor:
   ```sql
   SELECT public.agente_api_generar_clave('agentes');   -- copiala a AGENTES_CLAVE del entorno de la nube
   SELECT public.agente_api_generar_clave('revisor');   -- copiala a REVISOR_CLAVE, SÓLO en la Mac
   ```
   Cada clave se muestra **una sola vez** y en la base queda guardado sólo su hash. Las funciones de la ventanilla sólo aceptan pedidos POST (la base frena los GET con `SOLO_POST`): la clave nunca viaja en una URL, que quedaría en registros.
   - En el entorno de la nube, la única variable es `AGENTES_CLAVE`. **Ojo:** al reabrir "Variables de entorno" los valores se ven tapados (•••); si se guarda así, se guardan los puntitos. Para cambiar algo, borrar todo y volver a escribirlo. Si se pierde o se filtra, se corre de nuevo y la anterior deja de valer.
3. Publicar este PR (la pantalla Agentes del CRM). Hasta que el script 26 esté corrido, la pantalla sólo avisa "Falta correr el script 26".

## Entorno de la nube (claude.ai/code → Entornos)

Un entorno "iphonemood-agentes" sobre el repo `iMGroupArg/iphonemood-crm`, con estas variables secretas:

| Variable | Para qué | Quién la usa |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | **No hace falta cargarlas**: son públicas y `mesa.mjs` las toma de `config.js`. Si se cargan y vienen rotas (por ejemplo, la anon copiada del chat sale tapada como `eyJhbGci•••`), se ignoran | — |
| `AGENTES_CLAVE` | Clave de la ventanilla de los agentes | Todos |
| `REVISOR_CLAVE` | **NO va en la nube.** Vive sólo en la Mac (llavero), donde se deja el veredicto de Codex | — |
| `INBOX_USER`, `INBOX_PASSWORD` | Leer la Bandeja del bot. **Cargar sólo credenciales de SÓLO LECTURA** que dé el bot (las de Vercel permiten responder: esas no) | Bot |
| `OPENAI_API_KEY` | Codex en la nube | Todos (segunda opinión) |
| `META_TOKEN_LECTURA`, `META_AD_ACCOUNT_ID` | Fase 2: leer resultados de Meta (sólo lectura) | Pauta, Contenido |
| `GH_TOKEN` | Abrir PR (repo del CRM y del bot) | Landing, Bot |

Script de preparación del entorno:
```bash
npm install -g @openai/codex   # opcional: opinión de Codex dentro de la corrida (el veredicto formal sale de la Mac)
```

**El token de Meta con permiso de escritura NO va acá**: vive sólo en Vercel, para el ejecutor de la Fase 2.

## Rutinas (hora de Argentina)

Cada rutina se crea con `/schedule` y lleva este prompt: "Sos el agente `<nombre>` de iPhoneMood. Leé CLAUDE.md y .claude/agents/<nombre>.md y hacé la corrida `<corrida>` siguiendo la skill indicada. Al final registrá en la bitácora."

| Agente | Corrida | Cuándo | Skill |
|---|---|---|---|
| bot | diaria | todos los días 7:00 | `revision-bandeja` |
| contenido | ajuste diario | todos los días 8:00 | `plan-contenido-semanal` (ajuste) |
| ceo | resumen | todos los días 8:30 (los lunes, + directiva) | `resumen-diario` |
| pauta | diaria | todos los días 9:00 | `reporte-pauta` |
| finanzas | control | lunes 9:30 | `cierre-mensual` (control) |
| finanzas | cierre | día 1 de cada mes, 10:00 | `cierre-mensual` (cierre) |
| landing | auditoría + blog | domingo 10:00 | `auditoria-landing`, `blog-tanda` |
| contenido | plan semanal | domingo 18:00 | `plan-contenido-semanal` |
| bot | mejoras | viernes 16:00 | `revision-bandeja` (paso 6) |

Antes de agendar cada una, se dispara **una vez a mano** y se mira el resultado en CRM → Agentes (pestañas Informes y Bitácora).

## Codex: nube o Mac
- **El veredicto de Codex se escribe SIEMPRE desde la Mac**, con `REVISOR_CLAVE`, que nunca va a la nube. Así un agente manipulado en la nube no puede fabricar una "aprobación de Codex".
- En la nube, Codex (si anda) puede dar su opinión dentro de la corrida, como texto en `resumen`. El veredicto formal lo deja la Mac.
- Las propuestas que piden Codex quedan con "Codex: pendiente", y una tarea programada en la Mac las completa. La Mac ya tiene Codex configurado.
  - La tarea corre de lunes a sábado a las 11:00 y 19:00.
  - Busca `revision_codex = 'pendiente'` y sigue la skill `segunda-opinion-codex`.
  - Para eso la Mac necesita `REVISOR_CLAVE`, guardada en el llavero, no en el repo.
  - Con `REVISOR_CLAVE` sola, `mesa.mjs` puede leer (`leer`, `vistas`) y dejar el veredicto (`codex`), pero no proponer ni escribir en la bitácora.

## Límites conocidos (revisión de Codex, a propósito)
- **Hasta la Fase 2 no hay aumentos automáticos de pauta.** El gasto que informa el propio agente no autoriza gastar: sólo habilita el automático una medición hecha por el ejecutor con su propio token de Meta. Las bajadas sí pueden ser automáticas.
- **La Bandeja necesita un usuario de sólo lectura del bot.** Las credenciales de Vercel permiten responder a clientes. Hasta tenerlo (se pide cuando Franco pase el repo del bot), el agente del Bot no lee conversaciones: trabaja con el contrato y el catálogo.
- Las vistas no muestran texto libre (notas, observaciones), JSON de negocio ni columnas con nombre de secreto o dato personal. Si un agente necesita alguna de esas columnas, se agrega a mano y revisada, nunca con un `SELECT *`.
- **Volver a correr el script 26 después de cada migración que cree funciones nuevas**: en Supabase nacen ejecutables por PUBLIC, y el script se las saca a los agentes. El control 26.9 lo avisa con ❌.
- Las columnas `jsonb` de negocio (por ejemplo `datos`) pueden traer información que el filtro por nombre de columna no ve.

## Fase 2 (Meta), pendiente
Se arma con Franco:
- Instagram profesional, Business Manager y cuenta publicitaria;
- un usuario del sistema con dos tokens (escritura para Vercel, lectura para la nube);
- el ejecutor `api/_meta.js` detrás de una reescritura (sin sumar funciones de Vercel);
- un disparador cada 10 minutos con `pg_cron` + `pg_net` de Supabase (el mismo reloj que ya usa la facturación);
- las plantillas de placas;
- el Pixel.

## Probar las herramientas sin base
```bash
cd agentes && npm test
MESA_ENSAYO=1 node agentes/mesa.mjs proponer ejemplo.json
cd tests/sql && npm run test:agentes
```
