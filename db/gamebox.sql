-- =====================================================================
-- SplitBill — Migração: "Gamebox disponível?"
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- até aqui, quem dissesse "não vou ao jogo" (db/vai-jogo.sql) disparava
-- sozinho o aviso da gamebox ao grupo — "pode haver lugar a mais". Mas não
-- vou ao jogo E a minha box ficar livre são coisas diferentes: quem não vai
-- pode já a ter dado a alguém, pode estar à espera de decidir, ou pode
-- disponibilizá-la só até certa hora. O aviso saía na mesma, e o grupo ficava
-- a saber de um lugar que muitas vezes não existia.
--
-- Agora a box é uma PERGUNTA à parte, na mesma folha do jogo, e é ela que
-- avisa o grupo (`gamebox` na push-notificar.ts). O "não vou ao jogo" deixou
-- de notificar seja quem for.
--
-- QUEM VAI AO JOGO NÃO PODE TER A BOX DISPONÍVEL: a pergunta só aparece a
-- quem já disse que NÃO vai, e voltar a dizer "vou" apaga a resposta (ver
-- gameboxDisponivelPessoa() e marcarPresencaJogo() no app.js). É por isso que
-- a app apaga a chave em vez de a pôr a false — quem volta a não ir tem de
-- disponibilizar a box outra vez, de propósito.
--
-- FORMATO do jsonb (o que a app escreve e lê):
--   gamebox: {"Diogo": true, "Rui": false}
-- Só leva ENTRADAS EXPLÍCITAS. Quem não está na chave NÃO tem box disponível:
-- ao contrário do "vais ao jogo?", aqui o silêncio nunca vale por uma
-- oferta — ninguém dá a box sem o dizer.
--
-- Sem esta migração a app funciona à mesma: `GAMEBOX_COL` fica false, a
-- pergunta esconde-se e a coluna da box sai da tabela de quem vai. O que NÃO
-- volta é o aviso antigo do "não vou": esse sai de vez.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS gamebox jsonb;

COMMENT ON COLUMN splitbill.eventos.gamebox IS
  'Quem disponibilizou a gamebox neste jogo: {"Nome": true|false}. Só '
  'entradas explícitas, e só de quem NÃO vai ao jogo (eventos.vai_jogo) — '
  'quem não está na chave não tem box disponível. NULL = evento anterior a '
  'esta migração ou ninguém respondeu ainda.';

-- ── marcar_gamebox(evento, disponivel) ───────────────────────────────
-- Irmã da splitbill.marcar_presenca (db/jogo-aberto.sql), da
-- marcar_presenca_jogo (db/vai-jogo.sql) e da marcar_hora_sa (db/sa-hora.sql):
-- escreve só as chaves dos nomes desta conta em `eventos.gamebox`. SECURITY
-- DEFINER pela mesma razão — dar UPDATE em `eventos` a um convocado deixava-o
-- mexer no resto da linha (fatura, pagador, substituto).
--   p_disp = true/false  grava a resposta
--   p_disp = NULL        apaga-a (é o que corre quando alguém volta a dizer
--                        que VAI ao jogo: quem lá vai usa a própria box)
CREATE OR REPLACE FUNCTION splitbill.marcar_gamebox(p_evento_id bigint, p_disp boolean)
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
  v_jogo   jsonb;
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

  -- Só eventos por fechar: a box de um evento fechado é história.
  SELECT coalesce(e.gamebox, '{}'::jsonb), coalesce(e.vai_jogo, '{}'::jsonb)
    INTO v_atual, v_jogo
    FROM splitbill.eventos e
   WHERE e.id = p_evento_id
     AND e.total_fatura IS NULL;
  IF v_atual IS NULL THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  v_nova := v_atual;
  FOREACH v_nome IN ARRAY v_nomes LOOP
    -- A regra do lado do servidor, não só do ecrã: quem vai ao jogo ocupa a
    -- própria box e não a pode disponibilizar.
    IF p_disp AND coalesce((v_jogo ->> v_nome) = 'true', false) THEN
      RAISE EXCEPTION 'quem vai ao jogo não pode disponibilizar a gamebox';
    END IF;
    IF p_disp IS NULL THEN
      v_nova := v_nova - v_nome;
    ELSE
      v_nova := jsonb_set(v_nova, ARRAY[v_nome], to_jsonb(p_disp), true);
    END IF;
  END LOOP;

  UPDATE splitbill.eventos SET gamebox = v_nova WHERE id = p_evento_id;
  RETURN v_nova;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_gamebox(bigint, boolean) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_gamebox(bigint, boolean) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_gamebox(bigint, boolean) IS
  'Marca (ou apaga, com NULL) a gamebox da conta autenticada como disponível '
  'neste evento, em eventos.gamebox. Recusa disponibilizá-la a quem tem '
  'resposta explícita de que VAI ao jogo. SECURITY DEFINER pela mesma razão '
  'da marcar_presenca.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos`. A coluna entra nas
-- que já existem (RLS é por linha, não por coluna) — o admin e o substituto
-- gravam-na no PATCH normal do evento.
-- =====================================================================
