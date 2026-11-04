# Red de agentes de iPhoneMood: puesta en marcha

Seis agentes (`.claude/agents/`) que corren solos en la nube con agenda fija. Siguen las recetas de `.claude/skills/` y hablan con la base sólo a través de `agentes/mesa.mjs`. Franco decide todo lo importante desde **CRM → Agentes**.

```
 Rutinas en la nube ──► mesa.mjs (rol agentes_ro) ──► Supabase: agente_propuestas / bitácora / directivas / pauta_config
        │                                                              │
        └── Codex (segunda opinión)                     CRM → Agentes: Franco aprueba / rechaza / edita
                                                                       │
                                     Fase 2: ejecutor (código fijo) publica en Instagram y Meta Ads lo aprobado
```

## Fase 0: lo que hace Franco una sola vez

1. **Correr el script 24** en Supabase → SQL Editor: `db/para-correr/24_agentes.sql`. El final tiene que mostrar los 11 controles en ✅. Si aborta con FUNCIONES_SIN_CERRAR, no se instaló nada: avisar.
2. **Darles contraseña a los dos roles** (uno para los agentes y otro sólo para Codex). En el SQL Editor, con dos contraseñas largas **distintas**, generadas en el momento y **que no se guardan en ningún archivo**:
   ```sql
   ALTER ROLE agentes_ro      WITH LOGIN PASSWORD 'contraseña-larga-1';
   ALTER ROLE agentes_revisor WITH LOGIN PASSWORD 'contraseña-larga-2';
   ```
3. **Armar la cadena de conexión** (Supabase → Connect → Session pooler):
   - usuario `agentes_ro.<id-del-proyecto>`, con la contraseña del paso 2;
   - queda como `postgresql://agentes_ro.<id>:<contraseña>@<host-del-pooler>:5432/postgres`;
   - esa cadena es el secreto `AGENTES_DB_URL`. La misma con `agentes_revisor` y su contraseña es `REVISOR_DB_URL`;
   - descargar el certificado SSL del proyecto (Supabase → Database → Settings → SSL) y cargar su contenido como `AGENTES_DB_CA`. Sin él, las herramientas no se conectan: es lo que garantiza que hablan con la base real.
4. Publicar este PR (la pantalla Agentes del CRM). Hasta que el script 24 esté corrido, la pantalla sólo avisa "Falta correr el script 24".

## Entorno de la nube (claude.ai/code → Entornos)

Un entorno "iphonemood-agentes" sobre el repo `iMGroupArg/iphonemood-crm`, con estas variables secretas:

| Variable | Para qué | Quién la usa |
|---|---|---|
| `AGENTES_DB_URL` | Conexión del rol `agentes_ro` | Todos |
| `REVISOR_DB_URL` | **NO va en la nube.** Vive sólo en la Mac (llavero), donde corre el paso de Codex | — |
| `AGENTES_DB_CA` | Certificado de Supabase para verificar la conexión | Todos |
| `INBOX_USER`, `INBOX_PASSWORD` | Leer la Bandeja del bot. **Cargar sólo credenciales de SÓLO LECTURA** que dé el bot (las de Vercel permiten responder: esas no) | Bot |
| `OPENAI_API_KEY` | Codex en la nube | Todos (segunda opinión) |
| `META_TOKEN_LECTURA`, `META_AD_ACCOUNT_ID` | Fase 2: leer resultados de Meta (sólo lectura) | Pauta, Contenido |
| `GH_TOKEN` | Abrir PR (repo del CRM y del bot) | Landing, Bot |

Script de preparación del entorno:
```bash
cd agentes && npm install --silent && cd ..
npm install -g @openai/codex   # si falla, Codex corre desde la Mac (ver abajo)
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
- **El veredicto de Codex se escribe SIEMPRE desde la Mac**, con `REVISOR_DB_URL`, que nunca va a la nube. Así un agente manipulado en la nube no puede fabricar una "aprobación de Codex".
- En la nube, Codex (si anda) puede dar su opinión dentro de la corrida, como texto en `resumen`. El veredicto formal lo deja la Mac.
- Las propuestas que piden Codex quedan con "Codex: pendiente", y una tarea programada en la Mac las completa. La Mac ya tiene Codex configurado.
  - La tarea corre de lunes a sábado a las 11:00 y 19:00.
  - Busca `revision_codex = 'pendiente'` y sigue la skill `segunda-opinion-codex`.
  - Para eso la Mac también necesita `AGENTES_DB_URL`, guardada en el llavero, no en el repo.

## Límites conocidos (revisión de Codex, a propósito)
- **Hasta la Fase 2 no hay aumentos automáticos de pauta.** El gasto que informa el propio agente no autoriza gastar: sólo habilita el automático una medición hecha por el ejecutor con su propio token de Meta. Las bajadas sí pueden ser automáticas.
- **La Bandeja necesita un usuario de sólo lectura del bot.** Las credenciales de Vercel permiten responder a clientes. Hasta tenerlo (se pide cuando Franco pase el repo del bot), el agente del Bot no lee conversaciones: trabaja con el contrato y el catálogo.
- Las vistas no muestran texto libre (notas, observaciones), JSON de negocio ni columnas con nombre de secreto o dato personal. Si un agente necesita alguna de esas columnas, se agrega a mano y revisada, nunca con un `SELECT *`.
- **Volver a correr el script 24 después de cada migración que cree funciones nuevas**: en Supabase nacen ejecutables por PUBLIC, y el script se las saca a los agentes. El control 24.9 lo avisa con ❌.
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
