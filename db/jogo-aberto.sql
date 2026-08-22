-- =====================================================================
-- SplitBill — Migração: o jogo passa a ABRIR-SE À MÃO + cada convocado marca
-- se vai ou não vai aos jogos que ainda estão por abrir.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- desde que o calendário da época passou a ser criado de uma vez
-- (calSincronizar), "evento em aberto" deixou de querer dizer "dia de jogo":
-- bastava a data chegar para o jogo aparecer no ecrã inicial como conta por
-- fechar, mesmo que ninguém tivesse ido. Agora o jogo nasce em agenda
-- (`aberto = false`) e só passa a "em aberto" quando o admin — ou o substituto
-- nomeado — o ABRE, no ecrã inicial › Próximos Jogos em Alvalade.
--
-- DUAS COISAS, PORQUE ANDAM JUNTAS NO MESMO ECRÃ:
--   1. coluna `eventos.aberto` — o jogo está aberto? (só a app escreve, pelas
--      políticas RLS que já existem: quem pode editar o evento pode abri-lo).
--   2. função `marcar_presenca()` — qualquer convocado marca "vou"/"não vou"
--      num jogo por abrir, e isso mexe na lista de convocados (`eventos.amigos`).
--      É uma função SECURITY DEFINER, e não uma política de UPDATE em `eventos`:
--      dar UPDATE na tabela a quem não é admin abria a porta a mexer no resto
--      da linha (fatura, pagador, substituto). A função só acrescenta ou tira
--      os nomes DESTA conta, e só em eventos por fechar.
--
-- Sem esta migração a app funciona à mesma: `ABERTO_COL` fica false, o jogo
-- volta a abrir-se sozinho quando a data chega (comportamento antigo), o botão
-- "Abrir jogo" esconde-se e o "vou/não vou" só grava para quem já podia editar
-- o evento (admin/substituto). Nada rebenta.
-- =====================================================================

-- ── 1. eventos.aberto ────────────────────────────────────────────────
-- Deliberadamente SEM `NOT NULL DEFAULT`: `NULL` quer dizer "evento anterior a
-- esta migração", e a app trata esse caso como dantes (manda a data). É também
-- o que torna o retroactivo abaixo idempotente — só toca no que está a NULL.
ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS aberto boolean;

COMMENT ON COLUMN splitbill.eventos.aberto IS
  'O jogo já foi aberto (é o dia de jogo, há conta por fechar)? false = ainda '
  'é agenda, aparece em "Próximos Jogos em Alvalade". Só o admin ou o '
  'substituto do evento o põem a true. NULL = evento anterior a esta migração '
  '(a app decide pela data, como fazia antes).';

-- Retroactivo, uma vez só (WHERE aberto IS NULL): tudo o que já foi jogado ou
-- é de hoje/passado fica ABERTO — é o estado em que a app os mostrava até aqui
-- e é o que mantém o jogo a decorrer (ex.: Sporting vs Alverca, 22/08/2026) no
-- "Em aberto" do ecrã inicial. Os que ainda estão para vir ficam por abrir.
UPDATE splitbill.eventos e
   SET aberto = (
         e.total_fatura IS NOT NULL
         OR COALESCE(
              to_date(substring(e.data from '(\d{1,2}/\d{1,2}/\d{4})'), 'DD/MM/YYYY'),
              current_date
            ) <= current_date
       )
 WHERE e.aberto IS NULL;

-- ── 2. marcar_presenca(evento, vai) ──────────────────────────────────
-- Devolve a lista de convocados já actualizada. Chamada pela app em
-- POST /rest/v1/rpc/marcar_presenca (só para quem NÃO pode editar o evento —
-- o admin e o substituto gravam pelo caminho normal, o PATCH ao evento).
CREATE OR REPLACE FUNCTION splitbill.marcar_presenca(p_evento_id bigint, p_vai boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = splitbill, public
AS $$
DECLARE
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_nomes  text[];
  v_lista  jsonb;
  v_nova   jsonb;
BEGIN
  -- Conta autorizada a usar a app (mesma verificação de todas as políticas).
  IF NOT splitbill.is_allowed() THEN
    RAISE EXCEPTION 'conta sem acesso a esta app';
  END IF;

  -- Que nomes de amigo é que esta conta representa? (equivalência amigo↔conta,
  -- gerida pelo admin). Sem nenhum, não há presença que marcar.
  SELECT array_agg(au.amigo) INTO v_nomes
    FROM splitbill.amigo_users au
   WHERE lower(au.email) = v_email;
  IF v_nomes IS NULL OR array_length(v_nomes, 1) = 0 THEN
    RAISE EXCEPTION 'a tua conta ainda não está associada a nenhum nome';
  END IF;

  -- Só eventos por fechar: a lista de um evento fechado é história (e é dela
  -- que saem as dívidas).
  SELECT coalesce(e.amigos, '[]'::jsonb) INTO v_lista
    FROM splitbill.eventos e
   WHERE e.id = p_evento_id
     AND e.total_fatura IS NULL;
  IF v_lista IS NULL THEN
    RAISE EXCEPTION 'evento inexistente ou já fechado';
  END IF;

  IF p_vai THEN
    -- Acrescenta só os que faltam, ao fim — a ordem dos outros não se mexe.
    SELECT v_lista || coalesce(jsonb_agg(to_jsonb(n)) FILTER (WHERE NOT v_lista ? n), '[]'::jsonb)
      INTO v_nova
      FROM unnest(v_nomes) AS n;
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(x)) FILTER (WHERE NOT (x = ANY(v_nomes))), '[]'::jsonb)
      INTO v_nova
      FROM jsonb_array_elements_text(v_lista) AS x;
  END IF;

  UPDATE splitbill.eventos SET amigos = v_nova WHERE id = p_evento_id;
  RETURN v_nova;
END;
$$;

REVOKE ALL ON FUNCTION splitbill.marcar_presenca(bigint, boolean) FROM public;
GRANT EXECUTE ON FUNCTION splitbill.marcar_presenca(bigint, boolean) TO authenticated;

COMMENT ON FUNCTION splitbill.marcar_presenca(bigint, boolean) IS
  'Marca "vou"/"não vou" no evento: acrescenta ou tira de eventos.amigos os '
  'nomes de amigo associados à conta autenticada. SECURITY DEFINER de '
  'propósito — é o que evita ter de dar UPDATE em splitbill.eventos a quem não '
  'é admin nem substituto.';

-- Nota: NÃO é preciso mexer nas políticas de `eventos`. A coluna `aberto` entra
-- nas que já existem (RLS é por linha, não por coluna) — o admin e o substituto
-- gravam-na no PATCH normal do evento. Confirma na mesma com:
--   SELECT polname, polcmd FROM pg_policy
--    WHERE polrelid = 'splitbill.eventos'::regclass;
-- =====================================================================
