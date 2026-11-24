-- =====================================================================
-- SplitBill — Migração: em que CARRO vai cada um (a boleia).
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de db/leva-carro.sql (eventos.leva_carro) e de db/vai-jogo.sql.
--
-- O PROBLEMA QUE RESOLVE:
-- a folha já dizia quem leva carro (db/leva-carro.sql), mas não quem ia em
-- cada um — não se sabia se os carros chegavam, nem quem ainda andava à
-- procura de lugar. Agora cada um diz "Em que carro vais?" e a saída de
-- Alcochete mostra cada carro com quem lá vai, e quem ainda está sem carro.
--
-- FORMATO: jsonb {"Passageiro": "Condutor"}. O condutor não se escreve aqui
-- (está em leva_carro). Uma boleia cujo condutor deixou de levar carro não se
-- apaga — não é de quem a vê —, só deixa de contar na app.
--
-- Sem esta migração a app funciona à mesma: `BOLEIA_COL` fica false, a
-- pergunta fica só com "Levo o meu carro" e a saída mostra só os condutores.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS boleia jsonb;

COMMENT ON COLUMN splitbill.eventos.boleia IS
  'Em que carro vai cada um na saída de Alcochete: {"Passageiro": "Condutor"}. '
  'Só conta enquanto o condutor tiver leva_carro e o passageiro for ao jogo.';

-- ── marcar_boleia(evento, condutor) ──────────────────────────────────
-- Irmã da splitbill.marcar_carro (db/leva-carro.sql): escreve só as chaves
-- dos nomes desta conta em `eventos.boleia`. SECURITY DEFINER pela mesma razão
-- — dar UPDATE em `eventos` a um convocado deixava-o mexer no resto da linha.
--   p_condutor = 'Nome'  vou no carro dessa pessoa (tem de levar carro)
--   p_condutor = NULL    apaga a resposta (ainda não sei / deixei de ir)
CREATE OR REPLACE FUNCTION splitbill.marcar_boleia(p_evento_id bigint, p_condutor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = splitbill, public
AS $$
DECLARE
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_nomes  text[];
  v_atual  jsonb;
  v_carros jsonb;
  v_jogo   jsonb;
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

  -- Só eventos por fechar: as boleias de um evento fechado são história.
  SELECT coalesce(e.boleia, '{}'::jsonb), coalesce(e.leva_carro, '{}'::jsonb),
         coalesce(e.vai_jogo, '{}'::jsonb)
    INTO v_atual, v_carros, v_jogo
    FROM splitbill.eventos e
   WHERE e.id = p_evento_id
     AND e.total_fatura IS NULL;
  IF v_atual IS NULL THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  -- Só se vai no carro de quem o leva.
  IF p_condutor IS NOT NULL AND coalesce((v_carros ->> p_condutor) = 'true', false) = false THEN
    RAISE EXCEPTION 'esse carro não vai';
  END IF;

  v_nova := v_atual;
  FOREACH v_nome IN ARRAY v_nomes LOOP
    IF p_condutor IS NOT NULL THEN
      -- Quem disse que NÃO vai ao jogo não vai em carro nenhum para lá, e
      -- quem leva o próprio carro não vai no de outro.
      IF coalesce((v_jogo ->> v_nome) = 'false', false) THEN
        RAISE EXCEPTION 'quem não vai ao jogo não vai em carro nenhum';
      END IF;
      IF v_nome = p_condutor OR coalesce((v_carros ->> v_nome) = 'true', false) THEN
        RAISE EXCEPTION 'quem leva carro vai no seu';
      END IF;
      v_nova := jsonb_set(v_nova, ARRAY[v_nome], to_jsonb(p_condutor), true);
    ELSE
      v_nova := v_nova - v_nome;
    END IF;
  END LOOP;

  UPDATE splitbill.eventos SET boleia = v_nova WHERE id = p_evento_id;
  RETURN v_nova;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_boleia(bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_boleia(bigint, text) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_boleia(bigint, text) IS
  'Diz em que carro vai a conta autenticada (o nome de quem conduz), ou apaga '
  'a resposta com NULL, em eventos.boleia. Recusa carros que não vão, quem disse '
  'que não vai ao jogo e quem leva o próprio carro. SECURITY DEFINER pela mesma '
  'razão da marcar_carro.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos` — RLS é por linha, não
-- por coluna, e o admin/substituto gravam a coluna no PATCH normal do evento.
-- =====================================================================
