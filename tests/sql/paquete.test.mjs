// PRUEBA DE PAQUETE: lo que se le entrega a Franco (db/para-correr/N_*.sql) tiene que ser EXACTAMENTE lo que se probó
// (db/pendientes/*.sql), y el script 4 tiene que traer, sin parches de ningún banco de pruebas, la línea que llama a
// meli__revalidar_orden. Si no, un banco puede pasar con el archivo de pendientes mientras Franco corre otro distinto.
//
//   cd tests/sql && npm run test:paquete
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '../../db/');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };

const PAQUETE = [
  ['1_caja_aplicar_delta', 'caja_aplicar_delta'], ['2_stock_a_pedido', 'stock_a_pedido'], ['3_meli_esquema_base', 'meli_esquema_base'],
  ['4_meli_ventas_migration', 'meli_ventas_migration'], ['5_stock_ajustar_rpc', 'stock_ajustar_rpc'],
  ['6_catalogo_modelos_publico', 'catalogo_modelos_publico'], ['7_meli_vincular', 'meli_vincular'],
  ['8_canje_ultimo_precio_publico', 'canje_ultimo_precio_publico'], ['10_meli_barrido', 'meli_barrido'], ['11_presupuesto_por_token_lista', 'presupuesto_por_token_lista'],
  ['12_meli_cerrar_manual', 'meli_cerrar_manual'],
  ['13_presupuesto_bot', 'presupuesto_bot'],
  ['14_lote_pagos_conversion_lote', 'lote_pagos_conversion_lote'],
  ['15_actividades', 'actividades'],
  ['17_aviso_diario', 'aviso_diario'],
];
const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

console.log('\n══ Paquete de scripts para Franco (db/para-correr) ══\n');
for (const [num, orig] of PAQUETE) {
  const a = leer(path.join(RAIZ, 'para-correr', num + '.sql')), b = leer(path.join(RAIZ, 'pendientes', orig + '.sql'));
  check(`${num}.sql existe y es IDÉNTICO a pendientes/${orig}.sql`, a !== null && b !== null && a === b, a === null ? 'falta en para-correr' : b === null ? 'falta en pendientes' : 'difieren: sincronizar con cp');
}
const cuatro = leer(path.join(RAIZ, 'para-correr', '4_meli_ventas_migration.sql')) || '';
const sinCom = cuatro.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const proc = sinCom.slice(sinCom.indexOf('FUNCTION public.meli_procesar_orden'), sinCom.indexOf('FUNCTION public.meli_acreditar_orden'));
check('El script 4 entregado llama a meli__revalidar_orden en meli_procesar_orden, justo después de bloquear la orden y RECARGANDO `o`',
  /FROM public\.meli_ordenes WHERE id = p_orden_id FOR UPDATE;\s*IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;\s*o := public\.meli__revalidar_orden\(o\.id\);/.test(proc), 'falta la línea o := public.meli__revalidar_orden(o.id);');
check('El script 4 exige que el 7 esté corrido antes (guarda explícita)', /meli__revalidar_orden\(bigint\)'\) IS NULL/.test(cuatro));

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
