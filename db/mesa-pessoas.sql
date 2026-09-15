-- =====================================================================
-- SplitBill — Migração: nº de pessoas combinado para a mesa marcada.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- db/mesa-hora.sql guarda a HORA que o restaurante deu, mas não o Nº DE
-- PESSOAS combinado com ele — quem trata da marcação (o Barrona) costuma
-- saber os dois ao mesmo telefonema, e a app só recolhia um. Agora o nº de
-- pessoas vive junto da hora, no mesmo diálogo "Marcar mesa" da folha.
--
-- FORMATO: inteiro 1–99, ou NULL (não indicado — é opcional, nem sempre se
-- sabe o número ao certo). Uma contagem só, do evento — não é por pessoa.
--
-- Sem esta migração a app funciona à mesma: MESA_PESSOAS_COL fica false, o
-- campo "Nº de pessoas" esconde-se no diálogo "Marcar mesa" e fica só a
-- hora, como sempre foi.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS mesa_pessoas smallint;

COMMENT ON COLUMN splitbill.eventos.mesa_pessoas IS
  'Nº de pessoas combinado com o restaurante para a mesa do Sá (mesa_hora). '
  'NULL = não indicado. Desmarcar a mesa (mesa_hora = NULL) limpa também isto '
  '— ver splitbill.marcar_mesa_hora.';

ALTER TABLE splitbill.eventos DROP CONSTRAINT IF EXISTS eventos_mesa_pessoas_intervalo;
ALTER TABLE splitbill.eventos ADD CONSTRAINT eventos_mesa_pessoas_intervalo
  CHECK (mesa_pessoas IS NULL OR (mesa_pessoas > 0 AND mesa_pessoas <= 99));

-- ── marcar_mesa_hora(evento, hora, pessoas) ──────────────────────────
-- Mesma função de sempre (db/mesa-hora.sql), agora também a gravar o nº de
-- pessoas. Um CREATE OR REPLACE simples não chega aqui: acrescentar um
-- parâmetro por OR REPLACE cria um SEGUNDO overload em vez de substituir o
-- antigo (a assinatura muda), e ficavam os dois pendurados a confundir o
-- PostgREST. Por isso o DROP explícito da versão de dois parâmetros primeiro.
DROP FUNCTION IF EXISTS splitbill.marcar_mesa_hora(bigint, text);

CREATE OR REPLACE FUNCTION splitbill.marcar_mesa_hora(p_evento_id bigint, p_hora text, p_pessoas integer DEFAULT NULL)
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

  IF p_pessoas IS NOT NULL AND (p_pessoas <= 0 OR p_pessoas > 99) THEN
    RAISE EXCEPTION 'número de pessoas inválido';
  END IF;

  -- Só eventos por fechar: a hora (e o nº de pessoas) da mesa de um evento
  -- fechado é história.
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

  -- Desmarcar a mesa (p_hora NULL) limpa o nº de pessoas com ela: uma mesa
  -- por marcar não tem gente combinada para lado nenhum.
  UPDATE splitbill.eventos
     SET mesa_hora = p_hora,
         mesa_pessoas = CASE WHEN p_hora IS NULL THEN NULL ELSE p_pessoas END
   WHERE id = p_evento_id;
  RETURN p_hora;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_mesa_hora(bigint, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_mesa_hora(bigint, text, integer) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_mesa_hora(bigint, text, integer) IS
  'Grava (ou desmarca, com p_hora NULL) a hora e o nº de pessoas da mesa do '
  'Sá. Só para o admin, o substituto do evento ou o gestor da mesa (config '
  '"gestor_mesa"). SECURITY DEFINER pela mesma razão da marcar_hora_sa. '
  'Substitui a versão de dois parâmetros de db/mesa-hora.sql.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos` — RLS é por linha, não
-- por coluna, e o admin/substituto gravam a coluna no PATCH normal do evento.
-- =====================================================================
