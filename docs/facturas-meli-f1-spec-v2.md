# Facturas de Mercado Libre — Fase 1 — ESPECIFICACIÓN v2 (reemplaza el contrato de datos de facturas-meli-f1-spec.md)

Fecha: 2026-10-13. Mantiene TODAS las reglas de facturas-meli-f1-spec.md (emisor único fijo, sin DNI/CUIT, sin editar importes, sin estado optimista, escapar texto, sin SQL en la UI). Lo que cambia es el contrato con la base (script 16, db/para-correr/16_meli_facturas.sql, aún no corrido en producción) y tres decisiones de Franco: se registra el TIPO de comprobante; una factura = UNA orden; motivo de "no corresponde" = LISTA CERRADA.

## Lectura
`supa.from('meli_facturas').select('orden_id,estado,tipo,pto_venta,numero,emitida_el,motivo,version,marcada_por,marcada_en')`
- `orden_id` = meli_ordenes.meli_order_id (TEXTO, no el id interno). Sin fila = pendiente.
- Si la tabla no existe (error 42P01 o PGRST205): ocultar la sección sin romper nada.
- Cargar la versión de cada fila: es obligatoria para escribir.

## Escritura (única vía)
`supa.rpc('meli_factura_marcar', { p_orden, p_estado, p_tipo, p_pto_venta, p_numero, p_emitida_el, p_motivo, p_version_esperada })` — nombres EXACTOS; los que no aplican se omiten o van null.
- p_estado: 'emitida' | 'no_corresponde' | 'pendiente' ('pendiente' = REABRIR).
- emitida: p_tipo 'A'|'B'|'C'|'E'|'M'; p_pto_venta entero 1–99999; p_numero entero 1–99999999; p_emitida_el 'YYYY-MM-DD', no futura (hora de Argentina). Sin p_motivo.
- no_corresponde: p_motivo ∈ no_es_venta_real | cancelada_o_devuelta | factura_global_de_otro_periodo | exenta_o_no_gravada | otro_ver_nota_interna. Sin texto libre. Nada más.
- pendiente (reabrir): todo null salvo p_version_esperada.
- p_version_esperada: la `version` de la fila en pantalla, o null si la orden no tenía fila. SIEMPRE se manda.
- Respuesta: { ok:true, orden_id, estado, version, sin_cambios? }; sin_cambios:true es éxito (ya estaba así).
- Se MUESTRA como "C 0003-00001234" (tipo, pto de venta a 4 dígitos, número a 8) pero se ENVÍA y guarda como enteros separados. No existe un número en texto "0003-00001234" en el contrato.
- "Quién marcó" lo pone la base (email del token): la pantalla no manda ni muestra otro nombre.

## Transiciones
- Desde pendiente/sin fila → emitida o no_corresponde.
- Desde emitida o no_corresponde solo se puede REABRIR; para cambiar número o motivo: reabrir y registrar de nuevo (si no, FACTURA_YA_REGISTRADA).
- Repetir lo mismo → sin_cambios.
- Un comprobante (tipo+pto+número) corresponde a UNA sola orden; si una factura cubre varias ventas, las demás se marcan no_corresponde con factura_global_de_otro_periodo.

## Errores (error.message; detalle en error.details) — mostrarlos en castellano y NO cambiar el estado en pantalla
FACTURA_CAMBIO_RECARGAR (otra persona la cambió: recargar y reintentar) · FACTURA_YA_REGISTRADA (reabrir antes) · NUMERO_REPETIDO (ese comprobante ya está en otra orden; details dice cuál) · ESTADO_INVALIDO · TIPO_INVALIDO · PUNTO_VENTA_INVALIDO · NUMERO_INVALIDO · FECHA_INVALIDA · MOTIVO_INVALIDO · DATOS_SOBRANTES · ORDEN_INEXISTENTE · "no autorizado" (42501).

## Textos fijos en pantalla
- "El CRM no emite facturas: acá solo se registra la que emitiste. Tiene que ser a nombre de Franco Ezequiel Velas y por el importe real de la venta."
- "Reabrir NO anula el comprobante ante ARCA; el número queda en el historial."
- "Cancelar o revertir la orden no cambia su factura."
- Motivos, tipos y demás códigos se traducen a castellano en la UI. El historial no lleva comprador, DNI/CUIT, dirección ni importes.

## "Ventas sin factura"
La calcula la pantalla: estado pendiente o sin fila Y la orden NO está revertida, cancelada ni cerrada a mano.

## Pruebas (actualizar las existentes)
Formato "C 0003-00001234" y envío como enteros; versión enviada siempre (null sin fila); cada error en castellano sin cambiar estado; sin_cambios = éxito; motivo solo de la lista cerrada (desplegable, nada de campo de texto); reabrir manda solo la versión; tabla inexistente oculta la sección; sin DNI/CUIT/dirección en ningún lado.

## Entrega
Commit local en la rama codex/facturas-meli-f1, sin push ni deploy ni la marca de despliegue. Revisa una sesión de Claude. El SQL (script 16) NO se toca.

## Nota de campos del cliente (aprendida en la revisión de Actividades F1)
En el estado del CRM el cierre manual de una orden llega como `cerradaManual` (un OBJETO), no como `cerradaManualEn`. Para "ventas sin factura" tratá como cerrada a mano a una orden si existe `cerradaManual` o `cerradaManualEn`. Confirmá en src/modules/meli-ordenes.js y src/modules/meli-vincular.js los nombres reales (revertida: `revertidaEn`; cerrada: `cerradaManual`) antes de usarlos, y cubrí ambas formas con una prueba.
