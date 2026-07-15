-- Actualizar RPC get_reparacion_publica para incluir campos del presupuesto
-- Ejecutar en Supabase > SQL Editor

CREATE OR REPLACE FUNCTION get_reparacion_publica(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rep RECORD;
  v_tel TEXT;
BEGIN
  SELECT r.*
  INTO v_rep
  FROM reparaciones r
  WHERE r.token_seguimiento = p_token;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Teléfono del negocio (hardcodeado o desde config)
  v_tel := '3413662150';

  RETURN json_build_object(
    'id',               v_rep.id,
    'cliente',          v_rep.cliente,
    'equipo',           v_rep.equipo,
    'falla',            v_rep.falla,
    'estado',           v_rep.estado,
    'condicion_ingreso', v_rep.condicion_ingreso,
    'telefono_negocio', v_tel,
    -- Campos para el presupuesto
    'precio_final',     v_rep.precio_final,
    'tecnico',          v_rep.tecnico,
    'clave',            v_rep.clave_desbloqueo,
    'creado_en',        v_rep.creado_en
  );
END;
$$;
