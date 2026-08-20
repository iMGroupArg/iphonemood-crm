-- PASO A · Asignar IMEIs a equipos que YA estan en el sistema pero sin numero.
-- Seguro: no borra nada, solo completa el dato que faltaba.
-- El candado de IMEI unico validara que ninguno este repetido.

-- iPhone 17 Pro Max Plata  (2 u.)
UPDATE stock SET imeis = ARRAY['350015752735310', '356977601099285'], cantidad = 2
 WHERE id = '5d99cf70-a82f-437f-9d0b-d3c802b0ddc3';

-- iPhone 15  (2 u.)
UPDATE stock SET imeis = ARRAY['359641639704277', '350795428192570'], cantidad = 2
 WHERE id = '0342909b-995e-45e0-a2dc-3a34ee4bcef4';

-- iPhone 16 Pro Max 256GB Titanio Natural  (1 u.)
UPDATE stock SET imeis = ARRAY['358594369490586'], cantidad = 1
 WHERE id = 'd2bb30af-65e3-49cc-85df-837af635ccbb';

-- iPhone 14 128GB Morado  (1 u.)
UPDATE stock SET imeis = ARRAY['359462811796316'], cantidad = 1
 WHERE id = '226ebf5d-a67e-4b79-bd8c-a033ba779507';

-- iPhone 14 128GB Amarillo  (1 u.)
UPDATE stock SET imeis = ARRAY['356691197458603'], cantidad = 1
 WHERE id = 'cd66d6b2-af4f-4dce-b1bf-637069541049';

-- PASO B · Corregir los dos IMEIs mal tipeados

-- iPhone 16 Pro Max Titanio Desierto: empezaba con 6 en vez de 3
UPDATE stock SET imeis = ARRAY['359447962894861']
 WHERE imeis @> ARRAY['659447962894861'];

-- iPhone 17 Pro 256GB Plata: tenia un digito repetido (16 en vez de 15)
UPDATE stock SET imeis = ARRAY['350332842726146']
 WHERE imeis @> ARRAY['3503328427226146'];

-- Verificacion final
SELECT nombre, cantidad, imeis FROM stock
 WHERE categoria='iphone' ORDER BY nombre;
