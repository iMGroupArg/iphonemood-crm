-- ============================================================
-- AJUSTE DE STOCK contra el relevamiento del 30-07-2026
-- Pasos A y B: solo corrigen y completan datos (no borran).
-- Paso C: SI borra 2 equipos vendidos. Revisalo antes de correr.
-- ============================================================

-- PASO A · Corregir IMEIs mal tipeados

-- iPhone 16 Pro Max Titanio Desierto — empezaba con 6 en vez de 3
UPDATE stock SET imeis = ARRAY['359447962894861'] WHERE imeis @> ARRAY['659447962894861'];

-- iPhone 17 Pro 256GB Plata — tenia un digito repetido
UPDATE stock SET imeis = ARRAY['350332842726146'] WHERE imeis @> ARRAY['3503328427226146'];

-- iPhone 15 128GB Negro — tenia un digito de mas
UPDATE stock SET imeis = ARRAY['351698479040533'] WHERE imeis @> ARRAY['3516984791140533'];


-- PASO B · Asignar IMEIs a equipos que ya estaban cargados sin numero

-- 17 Pro Max Silver nuevos  ->  fila 'iPhone 17 Pro Max Plata'
UPDATE stock SET imeis = ARRAY['350015752735310', '356977601099285'], cantidad = 2 WHERE id = '5d99cf70-a82f-437f-9d0b-d3c802b0ddc3';

-- iPhone 15 Blue nuevos  ->  fila 'iPhone 15'
UPDATE stock SET imeis = ARRAY['359641639704277', '350795428192570'], cantidad = 2 WHERE id = '0342909b-995e-45e0-a2dc-3a34ee4bcef4';

-- 16 Pro Max Natural usado  ->  fila 'iPhone 16 Pro Max 256GB Titanio Natural'
UPDATE stock SET imeis = ARRAY['358594369490586'], cantidad = 1 WHERE id = 'd2bb30af-65e3-49cc-85df-837af635ccbb';

-- 14 Violeta usado  ->  fila 'iPhone 14 128GB Morado'
UPDATE stock SET imeis = ARRAY['359462811796316'], cantidad = 1 WHERE id = '226ebf5d-a67e-4b79-bd8c-a033ba779507';

-- 14 Amarillo usado  ->  fila 'iPhone 14 128GB Amarillo'
UPDATE stock SET imeis = ARRAY['356691197458603'], cantidad = 1 WHERE id = 'cd66d6b2-af4f-4dce-b1bf-637069541049';


-- PASO C · Dar de baja lo vendido que seguia figurando disponible

-- iPhone 17 Pro Plata: vendido, confirmado ausente en el conteo
DELETE FROM stock WHERE imeis @> ARRAY['353621841928399'];

-- iPhone 13 Rosa: de los 3 del sistema solo hay 2 en el local
DELETE FROM stock WHERE imeis @> ARRAY['355939491030201'];

-- Verificacion
SELECT nombre, cantidad, imeis, notas FROM stock WHERE categoria='iphone' ORDER BY nombre;
