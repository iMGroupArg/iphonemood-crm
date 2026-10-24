# Facturación automática directo con ARCA — plan técnico (borrador, sin construir)

Fecha: 2026-10-24. Complementa el plan para leer (https://claude.ai/artifact/F4LYskancC8LiUnpFtWSn9). Nada de esto está construido ni corrido en producción.

## 0. Decisiones de Franco (22-10-2026)
- Camino **A (directo a ARCA) + C (subir la factura a Mercado Libre)**. Sin proveedor de API.
- Solo **Factura C** y **Nota de Crédito C**, como Responsable Monotributo, persona física.
- Ventas de Mercado Libre: siempre el emisor de Franco. Otras ventas: las que se habiliten, desde un panel que permite varios emisores (cada uno con su Clave Fiscal personal).
- Nota de crédito automática cuando Mercado Libre anula una venta ya facturada.
- Topes de categoría: seguimiento interno informativo, no bloquea.
- El certificado se crea entre Franco y Claude, empezando por el ambiente de prueba.

**Sin responder todavía** (se necesita para cerrar el diseño): qué usó Franco para firmar en su otro sistema; si se emite al aprobarse el pago o al acreditarse; devoluciones parciales (hoy: manuales). Recomendación: emitir con el pago aprobado, por el total de la venta.

## 1. Piezas y dónde viven
| Pieza | Archivo propuesto | Nota |
|---|---|---|
| Acceso a ARCA (WSAA) | `api/_arca_wsaa.js` | Pedido de acceso firmado, ticket reutilizado, con bloqueo. |
| Facturación (WSFEv1) | `api/_arca_wsfe.js` | Último número, pedido de CAE, consulta de comprobante. |
| Orquestación | `api/_facturacion.js` | Intentos, reintentos, nota de crédito, subida a Mercado Libre. |
| PDF y QR | `api/_arca_pdf.js` | Comprobante legible con el QR de ARCA. |
| Endpoint | `/api/facturacion` → `api/meli/conectar.js?_f=facturacion` | Cuelga de una función existente (el límite de Vercel Hobby es 12 y hoy se usan las 12). |
| Panel | `src/modules/facturacion.js` | Emisores, botón «Emitir», lista de pendientes, interruptores. |
| Base | `db/pendientes/facturacion_*.sql` | Ver sección 3. |

Reglas del proyecto que se mantienen: Node CommonJS, `fetch` nativo, el servidor NO usa service-role (entra por RPC `SECURITY DEFINER` con un secreto compartido guardado con hash), todo SQL lo corre Franco.

## 2. Flujo de emisión
1. **Disparo**: botón del panel (usuario autenticado) o evento del servidor (pago aprobado / anulación). El endpoint exige sesión de un usuario autorizado, o un secreto de servidor para los eventos automáticos.
2. **Reservar el intento**: RPC `facturacion_intento_tomar` crea o reclama UN intento por (orden, tipo de comprobante) con un lease corto. Si ya hay uno emitido, devuelve ese. Si hay uno en curso de otro proceso, devuelve «ocupado».
3. **Ticket de acceso**: se lee de `facturacion_tokens`. Si falta o vence en menos de unos minutos, se pide uno nuevo bajo un bloqueo (advisory lock por emisor y servicio). Según la documentación de ARCA, mientras haya un ticket vigente no se puede pedir otro.
4. **Número**: `FECompUltimoAutorizado(PtoVta, CbteTipo)` + 1.
5. **Pedido**: `FECAESolicitar` con los datos de la sección 4.
6. **Resultado**: RPC `facturacion_intento_resultado` guarda CAE, vencimiento, número, importes y la respuesta técnica (sin datos del comprador) y marca `emitida`. En una sola transacción se anota el comprobante en el registro de la Fase 1.
7. **PDF y QR**, y para Mercado Libre, subida a `fiscal_documents` de la orden. Un fallo acá NO anula la factura: queda `pendiente_entrega` y se reintenta.
8. **Si el pedido se corta** sin saber si ARCA lo recibió: antes de reintentar se consulta el último número autorizado y el comprobante esperado (`FECompConsultar`). Nunca se reintenta a ciegas.

## 3. Base de datos (a escribir y probar con Codex; Franco la corre)
- `facturacion_emisores(id, nombre, cuit, condicion text check ('monotributo'), pto_venta int, ambiente check ('homologacion','produccion'), activo bool, cert_ref, cert_vence date, creado_en)`. Un emisor por persona.
- `facturacion_certificados(emisor_id, crt_cifrado, key_cifrada, iv, ...)`: cifrado con AES-GCM; la clave maestra vive solo en Vercel. Alternativa más simple para un solo emisor: variables secretas de Vercel. **Decisión abierta.**
- `facturacion_tokens(emisor_id, servicio, token, sign, expira_en)`: el ticket de acceso. Sin permisos para el navegador.
- `facturacion_intentos(id, emisor_id, orden_id, tipo_cbte int, estado, intentos int, lease_hasta, cae, cae_vence, pto_venta, numero, importe_total, fecha_cbte, comprobante_original_id, error_codigo, creado_en, actualizado_en)`. Índice único parcial en (orden, tipo) mientras el estado no sea fallido definitivo. Estados: `pendiente`, `emitiendo`, `emitida`, `pendiente_entrega`, `error`, `anulada`.
- Cambios a la Fase 1 (`meli_facturas`): agregar `emisor_id`, `cae`, `cae_vence`; el índice único pasa a (`emisor_id`, tipo, pto_venta, número); agregar el estado `anulada` con los datos de la nota de crédito. Las ventas que no son de Mercado Libre usan una tabla de comprobantes propia con la misma forma.
- Regla de base: toda orden de Mercado Libre queda atada al emisor de Franco (restricción, no solo pantalla).
- Todas las tablas con RLS cerrada, lectura solo para usuarios autorizados, escritura solo por RPC. Historial append-only, igual que la Fase 1.

## 4. Pedido de Factura C (a confirmar contra la documentación oficial y probar en homologación)
- Tipo de comprobante: Factura C = 11, Nota de Crédito C = 13 (según la tabla de tipos de ARCA; se pide a `FEParamGetTiposCbte`).
- `Concepto` 1 (productos). `DocTipo`/`DocNro`: consumidor final sin identificar (`99`/`0`) o DNI/CUIT cuando haga falta. `CondicionIVAReceptorId`: ARCA lo exige desde hace poco; confirmar el valor para consumidor final.
- Importes: Factura C no discrimina IVA: `ImpTotal`, `ImpNeto` = total, `ImpIVA` = 0. Moneda `PES`, cotización 1. Si la venta fue en dólares, el total en pesos sale de la cotización congelada de la venta; nunca se edita a mano.
- Nota de crédito: mismo importe, con `CbtesAsoc` apuntando a la factura original (tipo, punto de venta y número).
- Datos del receptor: se leen de Mercado Libre en el momento y viajan a ARCA; no se guardan en nuestra base.
- QR: URL de ARCA con el JSON en base64 (versión, fecha, CUIT, punto de venta, tipo, número, importe, moneda, cotización, tipo y número de documento del receptor, código de autorización).

## 5. Firma del pedido de acceso (la decisión técnica principal)
ARCA exige un pedido firmado con el certificado (formato CMS). Node no lo trae resuelto. Opciones: (1) librería de firma, (2) armar el formato con `crypto` propio y verificar contra OpenSSL, (3) servicio aparte solo para firmar. **Depende de cómo lo resolvió Franco en su otro sistema**; si hay código reutilizable, se evalúa primero. Cualquier dependencia nueva se consulta antes (hoy el proyecto no tiene ninguna).

## 6. Nota de crédito automática
Se emite si y solo si: hay factura emitida por el CRM con CAE; la orden pasó a cancelada o revertida de forma TOTAL; no existe ya una nota de crédito de esa factura; el interruptor está encendido. Mismo importe, asociada a la factura. Devoluciones parciales: a una lista de pendientes, sin emisión automática. Cada nota dispara un email al principio.

## 7. Seguridad
- Certificado y claves: nunca en el repositorio, chats ni registros. Acceso solo desde el servidor.
- El navegador no escribe ninguna tabla de facturación; solo llama al endpoint con la sesión del usuario.
- Interruptor general y tope de importe por factura para el modo automático. Un emisor pausado no emite.
- Registros sin datos personales. Sin DNI/CUIT en nuestra base.

## 8. Pruebas
- SQL: banco local con Postgres en memoria (restricciones, transiciones, permisos) y banco con Postgres real y varias conexiones a la vez (un intento por orden, un ticket por vez, sin bloqueos cruzados), con mutaciones. Revisión de Codex en cada pieza.
- Servidor: pruebas con ARCA simulado (respuestas de éxito, rechazo, corte a mitad de camino) y paridad de importes con las fórmulas del CRM.
- Real: todo contra el ambiente de PRUEBA de ARCA antes de emitir nada con valor fiscal, con un punto de venta y certificado de prueba.

## 9. Etapas
2.0 certificado y punto de venta de prueba, decisiones → 2.1 emitir una Factura C de prueba por línea de comando → 2.2 panel de emisores y botón con confirmación (prueba) → 2.3 producción con confirmación, PDF/QR, subida a Mercado Libre → 2.4 nota de crédito (botón, luego automática) → 2.5 emisión automática con interruptor, control diario y avisos.
Cada etapa se publica solo con el «desplegá» escrito de Franco.

## 10. Lo que no está verificado
Tipos y códigos exactos de comprobante, campos obligatorios vigentes, direcciones de los servicios de ARCA (pueden haber cambiado de dominio), requisitos de consumidor final, plazo de vigencia del ticket, y cómo emitir en nombre de otras personas. Se confirman con la documentación oficial de ARCA y con el contador antes de construir.
