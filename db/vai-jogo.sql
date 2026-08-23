-- =====================================================================
-- SplitBill — Migração: separar "vais ao Sá?" de "vais ao jogo?".
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- a folha dos Próximos Jogos só tinha UMA pergunta ("Vais a este jogo?") que na
-- prática decidia `eventos.amigos` — os convocados, i.e. quem vai ao Sá (a
-- refeição a seguir ao jogo, é isso que conta para o consumo). Mas ir ao jogo
-- sem ir ao Sá acontece com frequência, e não havia forma de o registar — só
-- interessava saber quem ia comer.
--
-- Agora há DUAS perguntas na mesma folha: "Vais ao Sá?" (continua a mexer em
-- `eventos.amigos`, sem mudanças) e "Vais ao jogo?" (nova, para gerir lugares).
-- Por DEFEITO quem vai ao Sá também vai ao jogo — mas cada um pode responder
-- às duas de forma independente.
--
-- FORMATO do jsonb (o que a app escreve e lê):
--   vai_jogo: {"Diogo": true, "Rui": false}
-- Só leva ENTRADAS EXPLÍCITAS — quem não está na chave segue por defeito a
-- resposta ao Sá (ver vaiAoJogoPessoa() no app.js). Guardar só o que é
-- explícito é o que permite ao defeito continuar a acompanhar o Sá quando este
-- muda, para quem nunca respondeu à segunda pergunta.
--
-- Sem esta migração a app funciona à mesma: `VAI_JOGO_COL` fica false, a
-- segunda pergunta esconde-se e só fica a de sempre ("Vais ao Sá?"). Nada
-- rebenta — só não há como registar quem vai ao jogo sem ir ao Sá.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS vai_jogo jsonb;

COMMENT ON COLUMN splitbill.eventos.vai_jogo IS
  'Respostas EXPLÍCITAS a "vais ao jogo?": {"Nome": true|false}. Quem não '
  'tem entrada aqui segue por defeito a resposta ao Sá (eventos.amigos). '
  'NULL = evento anterior a esta migração ou ninguém respondeu ainda — tudo '
  'segue o Sá.';

-- ── marcar_presenca_jogo(evento, vai) ────────────────────────────────
-- Irmã da splitbill.marcar_presenca (db/jogo-aberto.sql), mas escreve na
-- resposta ao JOGO, não ao Sá: acrescenta/atualiza só as chaves dos nomes
-- desta conta em `eventos.vai_jogo`. SECURITY DEFINER pela mesma razão — dar
-- UPDATE em `eventos` a um convocado deixava-o mexer no resto da linha.
CREATE OR REPLACE FUNCTION splitbill.marcar_presenca_jogo(p_evento_id bigint, p_vai boolean)
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

  SELECT array_agg(au.amigo) INTO v_nomes
    FROM splitbill.amigo_users au
   WHERE lower(au.email) = v_email;
  IF v_nomes IS NULL OR array_length(v_nomes, 1) = 0 THEN
    RAISE EXCEPTION 'a tua conta ainda não está associada a nenhum nome';
  END IF;

  -- Só eventos por fechar: a resposta a um evento fechado é história.
  SELECT coalesce(e.vai_jogo, '{}'::jsonb) INTO v_atual
    FROM splitbill.eventos e
   WHERE e.id = p_evento_id
     AND e.total_fatura IS NULL;
  IF v_atual IS NULL THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  v_nova := v_atual;
  FOREACH v_nome IN ARRAY v_nomes LOOP
    v_nova := jsonb_set(v_nova, ARRAY[v_nome], to_jsonb(p_vai), true);
  END LOOP;

  UPDATE splitbill.eventos SET vai_jogo = v_nova WHERE id = p_evento_id;
  RETURN v_nova;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_presenca_jogo(bigint, boolean) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_presenca_jogo(bigint, boolean) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_presenca_jogo(bigint, boolean) IS
  'Marca "vou"/"não vou" ao JOGO (separado do Sá): escreve a chave dos nomes '
  'de amigo associados à conta autenticada em eventos.vai_jogo. SECURITY '
  'DEFINER pela mesma razão da marcar_presenca.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos`. A coluna entra nas
-- que já existem (RLS é por linha, não por coluna) — o admin e o substituto
-- gravam-na no PATCH normal do evento.
-- =====================================================================
