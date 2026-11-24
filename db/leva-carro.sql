-- =====================================================================
-- SplitBill — Migração: quem LEVA CARRO (os condutores da saída de Alcochete).
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de db/vai-jogo.sql (eventos.vai_jogo) e anda com db/saida-hora.sql:
-- sem a hora de saída a app não pergunta pelo carro.
--
-- O PROBLEMA QUE RESOLVE:
-- a hora de saída de Alcochete já está na folha do jogo, mas não se sabia em
-- que carros se ia: quem levava carro dizia-o no grupo e perdia-se na
-- conversa. Agora cada um diz "Levo carro" na mesma folha — colado ao "vou"
-- do jogo — e a saída passa a dizer "2 carros: Diogo e Barrona".
--
-- FORMATO: jsonb {"Nome": true}. Só se guarda o SIM: o silêncio não leva
-- carro, e um "não levo" explícito não diz nada a ninguém. Deixar de levar
-- apaga a chave.
--
-- Sem esta migração a app funciona à mesma: `LEVA_CARRO_COL` fica false, o
-- botão "Levo carro" não aparece e a saída fica só com a hora.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS leva_carro jsonb;

COMMENT ON COLUMN splitbill.eventos.leva_carro IS
  'Quem leva carro na saída de Alcochete: {"Nome": true}. Só o sim se guarda; '
  'deixar de levar apaga a chave. Só conta para quem vai ao jogo.';

-- ── marcar_carro(evento, leva) ───────────────────────────────────────
-- Irmã da splitbill.marcar_gamebox (db/gamebox.sql): escreve só as chaves dos
-- nomes desta conta em `eventos.leva_carro`. SECURITY DEFINER pela mesma razão
-- — dar UPDATE em `eventos` a um convocado deixava-o mexer no resto da linha
-- (fatura, pagador, substituto).
--   p_leva = true          passa a levar carro
--   p_leva = false / NULL  deixa de levar (apaga a chave) — é também o que
--                          corre quando alguém diz que já NÃO vai ao jogo
CREATE OR REPLACE FUNCTION splitbill.marcar_carro(p_evento_id bigint, p_leva boolean)
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

  -- Só eventos por fechar: os carros de um evento fechado são história.
  SELECT coalesce(e.leva_carro, '{}'::jsonb), coalesce(e.vai_jogo, '{}'::jsonb)
    INTO v_atual, v_jogo
    FROM splitbill.eventos e
   WHERE e.id = p_evento_id
     AND e.total_fatura IS NULL;
  IF v_atual IS NULL THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  v_nova := v_atual;
  FOREACH v_nome IN ARRAY v_nomes LOOP
    -- A regra do lado do servidor, não só do ecrã (o inverso da gamebox): quem
    -- disse que NÃO vai ao jogo não leva carro para lá.
    IF coalesce(p_leva, false) AND coalesce((v_jogo ->> v_nome) = 'false', false) THEN
      RAISE EXCEPTION 'quem não vai ao jogo não leva carro';
    END IF;
    IF coalesce(p_leva, false) THEN
      v_nova := jsonb_set(v_nova, ARRAY[v_nome], 'true'::jsonb, true);
    ELSE
      v_nova := v_nova - v_nome;
    END IF;
  END LOOP;

  UPDATE splitbill.eventos SET leva_carro = v_nova WHERE id = p_evento_id;
  RETURN v_nova;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_carro(bigint, boolean) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_carro(bigint, boolean) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_carro(bigint, boolean) IS
  'Marca (true) ou desmarca (false/NULL) que a conta autenticada leva carro na '
  'saída de Alcochete deste evento, em eventos.leva_carro. Recusa o sim a quem '
  'tem resposta explícita de que NÃO vai ao jogo. SECURITY DEFINER pela mesma '
  'razão da marcar_gamebox.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos`. A coluna entra nas
-- que já existem (RLS é por linha, não por coluna) — o admin e o substituto
-- gravam-na no PATCH normal do evento.
-- =====================================================================
