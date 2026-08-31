-- =====================================================================
-- SplitBill — Migração: a que HORAS cada um pode estar no Sá.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- saber QUEM vai ao Sá nunca chegou para marcar a mesa. O que o Barrona (quem
-- trata da marcação) precisa é da hora a partir da qual o grupo está todo
-- pronto — e essa é a hora do ÚLTIMO a poder chegar. Até aqui isso andava pelo
-- WhatsApp e chegava tarde. Agora quem diz "vou ao Sá" diz também a partir de
-- que horas, na mesma folha do jogo.
--
-- FORMATO do jsonb (o que a app escreve e lê):
--   sa_hora: {"Diogo": "19:30", "Rui": "20:00"}
-- Só leva ENTRADAS EXPLÍCITAS, e só de quem vai ao Sá — quem não está na chave
-- ainda não respondeu (ver horaSaPessoa() no app.js). Quem desmarca a ida ao Sá
-- perde a entrada, senão a mesa ficava marcada à espera de quem já disse que
-- não ia.
--
-- Sem esta migração a app funciona à mesma: `SA_HORA_COL` fica false, a
-- pergunta da hora esconde-se e fica tudo como antes (quem vai ao Sá, sem hora).
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS sa_hora jsonb;

COMMENT ON COLUMN splitbill.eventos.sa_hora IS
  'Hora a partir da qual cada pessoa pode estar no Sá: {"Nome": "HH:MM"}. Só '
  'entradas explícitas e só de quem vai ao Sá (eventos.amigos). NULL = evento '
  'anterior a esta migração ou ninguém respondeu ainda.';

-- ── marcar_hora_sa(evento, hora) ─────────────────────────────────────
-- Irmã da splitbill.marcar_presenca (db/jogo-aberto.sql) e da
-- marcar_presenca_jogo (db/vai-jogo.sql): escreve só as chaves dos nomes desta
-- conta em `eventos.sa_hora`. SECURITY DEFINER pela mesma razão — dar UPDATE em
-- `eventos` a um convocado deixava-o mexer no resto da linha (fatura, pagador,
-- substituto).
--   p_hora = 'HH:MM'  grava/actualiza a hora
--   p_hora = NULL     apaga a resposta (é o que corre quando alguém deixa de ir)
CREATE OR REPLACE FUNCTION splitbill.marcar_hora_sa(p_evento_id bigint, p_hora text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = splitbill, public
AS $$
DECLARE
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_nomes  text[];
  v_atual  jsonb;
  v_nova   jsonb;
  v_nome   text;
BEGIN
  IF NOT splitbill.is_allowed() THEN
    RAISE EXCEPTION 'conta sem acesso a esta app';
  END IF;

  -- O formato é validado AQUI e não só no cliente: esta hora vai depois para o
  -- corpo de uma notificação e para o ecrã de toda a gente.
  IF p_hora IS NOT NULL AND p_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'hora inválida (esperado HH:MM)';
  END IF;

  SELECT array_agg(au.amigo) INTO v_nomes
    FROM splitbill.amigo_users au
   WHERE lower(au.email) = v_email;
  IF v_nomes IS NULL OR array_length(v_nomes, 1) = 0 THEN
    RAISE EXCEPTION 'a tua conta ainda não está associada a nenhum nome';
  END IF;

  -- Só eventos por fechar: a hora de um evento fechado é história.
  SELECT coalesce(e.sa_hora, '{}'::jsonb) INTO v_atual
    FROM splitbill.eventos e
   WHERE e.id = p_evento_id
     AND e.total_fatura IS NULL;
  IF v_atual IS NULL THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  v_nova := v_atual;
  FOREACH v_nome IN ARRAY v_nomes LOOP
    IF p_hora IS NULL THEN
      v_nova := v_nova - v_nome;
    ELSE
      v_nova := jsonb_set(v_nova, ARRAY[v_nome], to_jsonb(p_hora), true);
    END IF;
  END LOOP;

  UPDATE splitbill.eventos SET sa_hora = v_nova WHERE id = p_evento_id;
  RETURN v_nova;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_hora_sa(bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_hora_sa(bigint, text) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_hora_sa(bigint, text) IS
  'Grava (ou apaga, com NULL) a hora a partir da qual a conta autenticada pode '
  'estar no Sá, em eventos.sa_hora. SECURITY DEFINER pela mesma razão da '
  'marcar_presenca.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos`. A coluna entra nas
-- que já existem (RLS é por linha, não por coluna) — o admin e o substituto
-- gravam-na no PATCH normal do evento.
-- =====================================================================
