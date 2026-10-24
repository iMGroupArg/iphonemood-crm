# Facturación con ARCA desde el CRM — estado del modo de prueba (2026-10-24)

Plan general aprobado por Franco: ver /Users/francovelas/.claude/plans/dazzling-tumbling-stardust.md. Emisor único (Franco Ezequiel Velas, monotributo, Factura C), emisión automática al procesar la venta, documento del comprador leído de Mercado Libre solo al emitir.

## Hecho (esta etapa)
- `api/_arca.js`: cliente de ARCA SIN dependencias. Firma CMS del login (WSAA) armada a mano con `crypto` de Node y verificada en pruebas contra `openssl smime -verify`; ticket con caché (interfaz lista para guardarlo en base); WSFEv1: FEDummy, FECompUltimoAutorizado, FECAESolicitar (Factura C: CbteTipo 11, Concepto 1, importe neto = total, sin IVA discriminado, CondicionIVAReceptorId), FECompConsultar.
- Modos por la variable ARCA_MODO: `simulacion` (por defecto; no toca la red; CAE falso marcado "SIMULADO"), `homologacion` (entorno de pruebas de ARCA), `produccion` (exige además ARCA_CONFIRMA_PRODUCCION=SI).
- El comprobante se arma SOLO desde la orden (importe en pesos; moneda ARS). El documento del comprador se valida (DNI 7–8 dígitos, CUIT/CUIL 11); sin documento solo se emite a consumidor final bajo un umbral configurable (ARCA_UMBRAL_CONSUMIDOR_FINAL); sin umbral se exige documento.
- El emisor sale de ARCA_CUIT; el módulo no acepta un emisor por parámetro.
- `tests/arca.test.mjs`: 20 casos, sin red.

## [NO VERIFICADO] — a confirmar en homologación
Códigos de tipo de documento (96 DNI, 80 CUIT, 86 CUIL, 99 consumidor final), códigos de condición IVA del receptor (5 consumidor final), orden exacto de los elementos de FECAESolicitar y nombres de las respuestas. La obligatoriedad de CondicionIVAReceptorId rige desde la RG 5616; ARCA pasa a rechazar sin ese dato desde el 1/12/2026.

## Falta (siguientes pasos)
1. Franco carga en Vercel (Production, tipo Secret, nunca por chat): ARCA_CUIT, ARCA_PTO_VTA, ARCA_CERT (contenido del .crt de homologación), ARCA_KEY (contenido de la clave privada) y, para probar contra ARCA, ARCA_MODO=homologacion.
2. Diagnóstico de solo lectura (login + FEDummy + último autorizado) como acción de la pantalla de Mercado Libre, sin emitir.
3. Base de datos: meli_comprobantes y arca_tokens (script nuevo), numeración serializada, función servidor con secreto.
4. Orquestador y enganche al procesar; comprobante imprimible con QR.
5. Homologación de punta a punta, contador, certificado de producción y actualización de la política de privacidad antes de activar producción.
