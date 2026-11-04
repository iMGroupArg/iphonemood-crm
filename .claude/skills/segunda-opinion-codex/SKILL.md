---
name: segunda-opinion-codex
description: Pedirle a Codex una revisión independiente (de una propuesta, un cierre, un diff o un plan) y dejar el veredicto en la mesa. Usala cuando el CEO o la regla de tu agente pida pasar algo por Codex.
---

# Segunda opinión de Codex

Codex es un modelo distinto que revisa **sin ver tu razonamiento**. Sólo ve los datos y la pregunta. Así sirve como control de verdad.

## Cómo
1. Armá un archivo con el contexto **mínimo y verificable**: la propuesta (o el diff, o los números), los datos de la base que la sostienen y la pregunta concreta. Por ejemplo: "¿hay algún dato inventado, algún producto sin stock o un precio que no coincide?"
2. Corré Codex en modo sólo lectura:
   ```bash
   codex exec -s read-only - < /tmp/revision.md > /tmp/codex.out 2>&1
   ```
   Pedile que termine con una línea `VEREDICTO: aprobado` o `VEREDICTO: objeciones`.
3. Guardá el veredicto en la propuesta:
   ```bash
   echo '{"id": 123, "veredicto": "objeciones", "texto": "<resumen de 3-10 líneas de lo que objetó>"}' | node agentes/mesa.mjs codex -
   ```
   Una objeción sobre un ajuste `auto` lo devuelve a `pendiente` sola.
   La acción `codex` usa `REVISOR_CLAVE`, que **existe sólo en la Mac**. En la nube, este paso no se puede hacer: dejá `pedir_codex: true` y la opinión de Codex como texto en el `resumen`.
4. **Si no estás de acuerdo con Codex, no lo pises.** Agregá tu postura en `resumen` o en la bitácora. Franco ve las dos.

## Para código (Landing, Bot)
- `codex exec -s read-only "Revisá el diff de la rama X contra origin/main: bugs, seguridad, CSP, datos inventados. Terminá con VEREDICTO."`
- Rondas hasta que apruebe, o hasta 3. Si después de 3 rondas sigue con objeciones, el PR se abre igual, con las objeciones en la descripción.

## Si Codex no está disponible
Si no hay `codex` en el entorno o falta `OPENAI_API_KEY`:
- dejá la propuesta con `pedir_codex: true` (queda `revision_codex = pendiente`);
- registrá `hallazgo` "Codex no disponible en la nube".

La corrida local de la Mac completa esas revisiones pendientes (ver `agentes/README.md`).
