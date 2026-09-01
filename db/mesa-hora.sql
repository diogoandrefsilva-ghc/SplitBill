-- =====================================================================
-- SplitBill — Migração: a hora a que a MESA ficou marcada.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- a app já recolhe a que horas cada um PODE estar no Sá (db/sa-hora.sql) e
-- mostra o mapa dos votos. Mas quem marca a mesa é uma pessoa — o Barrona — e
-- a hora que ele conseguiu no restaurante não estava em lado nenhum: sabia-se
-- quem podia chegar quando, não a que horas era a mesa. Agora a hora marcada
-- vive no evento, e é a que fica em destaque na folha do jogo; os votos passam
-- a ser o que sempre foram, o que ajudou a escolhê-la.
--
-- FORMATO: texto 'HH:MM' (ou NULL, mesa por marcar). Uma hora só, do evento —
-- não é por pessoa, ao contrário do sa_hora.
--
-- Sem esta migração a app funciona à mesma: `MESA_HORA_COL` fica false, a
-- linha da mesa marcada esconde-se e fica só o resumo dos votos.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS mesa_hora text;

COMMENT ON COLUMN splitbill.eventos.mesa_hora IS
  'Hora a que a mesa do Sá ficou marcada (HH:MM). NULL = por marcar. É a hora '
  'do restaurante, não a de ninguém em particular (essa é a sa_hora).';

-- O formato é garantido também aqui: esta hora aparece no ecrã de toda a gente
-- e pode ir parar ao corpo de uma notificação.
ALTER TABLE splitbill.eventos DROP CONSTRAINT IF EXISTS eventos_mesa_hora_fmt;
ALTER TABLE splitbill.eventos ADD CONSTRAINT eventos_mesa_hora_fmt
  CHECK (mesa_hora IS NULL OR mesa_hora ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Quem trata da marcação. Fica na tabela genérica de configuração
-- (db/config-convocados.sql) para não andar espalhado por funções.
-- SE UM DIA A MESA PASSAR A SER DE OUTRA PESSOA, muda-se em DOIS sítios:
-- aqui (esta chave) e no `GESTOR_MESA_SA` do app.js, que é quem decide a quem
-- chega a notificação das horas.
INSERT INTO splitbill.config (chave, valor)
VALUES ('gestor_mesa', '{"amigo": "Barrona"}'::jsonb)
ON CONFLICT (chave) DO NOTHING;

-- ── marcar_mesa_hora(evento, hora) ───────────────────────────────────
-- Irmã da splitbill.marcar_hora_sa (db/sa-hora.sql), com uma diferença: aquela
-- deixa cada um escrever a SUA hora, esta deixa UMA pessoa escrever a do
-- grupo. Por isso a permissão é mais apertada — o admin, o substituto do
-- evento, ou a pessoa que trata da marcação (config 'gestor_mesa').
-- SECURITY DEFINER pela mesma razão de sempre: dar UPDATE em `eventos` ao
-- gestor da mesa deixava-o mexer na fatura, no pagador e no substituto.
--   p_hora = 'HH:MM'  grava/actualiza a hora da mesa
--   p_hora = NULL     desmarca (a mesa volta a "por marcar")
CREATE OR REPLACE FUNCTION splitbill.marcar_mesa_hora(p_evento_id bigint, p_hora text)
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

  -- Só eventos por fechar: a hora da mesa de um evento fechado é história.
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
    RAISE EXCEPTION 'só quem trata da marcação da mesa (ou o administrador) pode pôr esta hora';
  END IF;

  UPDATE splitbill.eventos SET mesa_hora = p_hora WHERE id = p_evento_id;
  RETURN p_hora;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_mesa_hora(bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_mesa_hora(bigint, text) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_mesa_hora(bigint, text) IS
  'Grava (ou desmarca, com NULL) a hora a que a mesa do Sá ficou marcada. Só '
  'para o admin, o substituto do evento ou o gestor da mesa (config '
  '"gestor_mesa"). SECURITY DEFINER pela mesma razão da marcar_hora_sa.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos` — RLS é por linha, não
-- por coluna, e o admin/substituto gravam a coluna no PATCH normal do evento.
-- =====================================================================
