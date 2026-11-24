-- =====================================================================
-- SplitBill — Migração: a hora de SAÍDA DE ALCOCHETE.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de db/mesa-hora.sql (a chave 'gestor_mesa' em splitbill.config).
--
-- O PROBLEMA QUE RESOLVE:
-- no dia de jogo o grupo sai junto de Alcochete, e a hora a que se sai andava
-- combinada por fora da app. A folha do jogo já tinha UMA hora do grupo — a da
-- mesa marcada no Sá (db/mesa-hora.sql) — e com ela sozinha já houve quem
-- perguntasse "esta hora é de quê?". Agora há duas, cada uma com o seu nome:
-- a saída de Alcochete e a mesa marcada no Sá.
--
-- FORMATO: texto 'HH:MM' (ou NULL, por definir). Uma hora só, do evento —
-- como a mesa_hora, não é por pessoa (essa é a sa_hora).
--
-- Sem esta migração a app funciona à mesma: `SAIDA_HORA_COL` fica false, a
-- linha da saída não aparece e o diálogo "Marcar horas" fica só com a mesa.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS saida_hora text;

COMMENT ON COLUMN splitbill.eventos.saida_hora IS
  'Hora a que o grupo sai de Alcochete no dia do jogo (HH:MM). NULL = por '
  'definir. Hora do grupo, como a mesa_hora (a da mesa marcada no Sá).';

-- O formato é garantido também aqui: esta hora aparece no ecrã de toda a gente
-- e vai parar ao corpo de uma notificação.
ALTER TABLE splitbill.eventos DROP CONSTRAINT IF EXISTS eventos_saida_hora_fmt;
ALTER TABLE splitbill.eventos ADD CONSTRAINT eventos_saida_hora_fmt
  CHECK (saida_hora IS NULL OR saida_hora ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ── marcar_saida_hora(evento, hora) ──────────────────────────────────
-- Irmã da splitbill.marcar_mesa_hora (db/mesa-hora.sql, db/mesa-pessoas.sql),
-- com a MESMA permissão: o admin, o substituto do evento ou quem trata da
-- marcação da mesa (config 'gestor_mesa') — quem organiza o dia. É função à
-- parte, e não um quarto parâmetro daquela, porque é outra decisão: a mesa
-- combina-se ao telefone com o restaurante, a saída combina-se no grupo.
-- SE UM DIA a saída passar a ser de outra pessoa, é aqui que se separa (uma
-- chave nova em splitbill.config, como a 'gestor_mesa').
-- SECURITY DEFINER pela mesma razão de sempre: dar UPDATE em `eventos` a quem
-- organiza deixava-o mexer na fatura, no pagador e no substituto.
--   p_hora = 'HH:MM'  grava/actualiza a hora de saída
--   p_hora = NULL     apaga (volta a "por definir")
CREATE OR REPLACE FUNCTION splitbill.marcar_saida_hora(p_evento_id bigint, p_hora text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = splitbill, public
AS $$
DECLARE
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_gestor  text;
  v_pode    boolean;
BEGIN
  IF NOT splitbill.is_allowed() THEN
    RAISE EXCEPTION 'conta sem acesso a esta app';
  END IF;

  IF p_hora IS NOT NULL AND p_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'hora inválida (esperado HH:MM)';
  END IF;

  -- Só eventos por fechar: a hora de saída de um evento fechado é história.
  PERFORM 1 FROM splitbill.eventos e
    WHERE e.id = p_evento_id AND e.total_fatura IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  SELECT coalesce(c.valor ->> 'amigo', 'Barrona') INTO v_gestor
    FROM splitbill.config c WHERE c.chave = 'gestor_mesa';
  v_gestor := coalesce(v_gestor, 'Barrona');

  SELECT splitbill.is_admin()
         OR EXISTS (SELECT 1 FROM splitbill.eventos e
                     WHERE e.id = p_evento_id
                       AND lower(coalesce(e.substituto_email, '')) = v_email)
         OR EXISTS (SELECT 1 FROM splitbill.amigo_users au
                     WHERE lower(au.email) = v_email
                       AND au.amigo = v_gestor)
    INTO v_pode;
  IF NOT v_pode THEN
    RAISE EXCEPTION 'só quem trata da marcação (ou o administrador) pode pôr a hora de saída';
  END IF;

  UPDATE splitbill.eventos SET saida_hora = p_hora WHERE id = p_evento_id;
  RETURN p_hora;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_saida_hora(bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_saida_hora(bigint, text) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_saida_hora(bigint, text) IS
  'Grava (ou apaga, com NULL) a hora a que o grupo sai de Alcochete. Só para o '
  'admin, o substituto do evento ou o gestor da mesa (config "gestor_mesa"). '
  'SECURITY DEFINER pela mesma razão da marcar_mesa_hora.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos` — RLS é por linha, não
-- por coluna, e o admin/substituto gravam a coluna no PATCH normal do evento.
-- =====================================================================
