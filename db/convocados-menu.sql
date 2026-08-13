-- =====================================================================
-- SplitBill — Migração: convocados e menu do evento passam a viver na BD.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- até aqui a lista de convocados de um evento NÃO existia na base de dados.
-- Só existia colada às ordens (`ordem_amigos`), e o menu não existia de todo.
-- Ao recarregar a app, o histórico é reconstruído a partir do servidor e a
-- lista era deduzida de quem aparecia nas ordens — num evento ainda sem nada
-- lançado isso dá lista VAZIA. Resultado: criava-se o evento com os amigos
-- todos pré-preenchidos, fechava-se a app, e ao voltar a entrar os amigos
-- tinham desaparecido (o menu não, porque esse tinha um fallback que os
-- reconstruía a partir de todos os eventos). Alterações manuais ao menu de um
-- evento perdiam-se pela mesma razão.
--
-- PORQUÊ COLUNAS jsonb E NÃO TABELAS NOVAS (mesma decisão da `fatura`):
--   · herdam as políticas RLS de `eventos` — quem pode editar o evento pode
--     editar os convocados e o menu. Zero políticas novas.
--   · são sempre lidas e escritas inteiras, com o evento; não há consultas
--     relacionais por convocado (essas fazem-se por `ordem_amigos`).
--   · o upsert do evento que já existe passa a levar mais dois campos — não
--     é preciso sincronizar linhas nem podar órfãos.
--
-- FORMATO do jsonb (o que a app escreve e lê):
--   amigos: ["Diogo", "Rui", "Tiago"]        -- ordem preservada
--   menu:   {"Imperial": 1.50, "Bifana": 3.20}
--
-- Sem esta migração a app funciona à mesma: `AMIGOS_COL`/`MENU_COL` ficam a
-- false, a lista e o menu guardam-se só no localStorage do dispositivo (a app
-- deixou de os deitar fora ao recarregar) e avisa na consola. Nada rebenta —
-- apenas não viajam entre telemóveis.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS amigos jsonb;

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS menu jsonb;

COMMENT ON COLUMN splitbill.eventos.amigos IS
  'Convocados do evento: ["Nome", ...]. É a lista de candidatos editada nas '
  'Definições do evento — não implica que a pessoa tenha consumido. Quem '
  'consumiu está em ordem_amigos/oferta_para. NULL = evento anterior a esta '
  'migração (a app deduz a lista das ordens).';

COMMENT ON COLUMN splitbill.eventos.menu IS
  'Menu do evento: {"artigo": preco_unitario, ...}. NULL = evento anterior a '
  'esta migração (a app usa o menu agregado de todos os eventos).';

-- Retroativo: dar aos eventos antigos a lista que se consegue deduzir das
-- ordens e ofertas, para não ficarem a null. Só toca em linhas ainda por
-- preencher (WHERE amigos IS NULL) — correr outra vez não desfaz edições.
UPDATE splitbill.eventos e
   SET amigos = COALESCE(sub.lista, '[]'::jsonb)
  FROM (
    SELECT ev.id,
           jsonb_agg(DISTINCT p.amigo) FILTER (WHERE p.amigo IS NOT NULL) AS lista
      FROM splitbill.eventos ev
      LEFT JOIN LATERAL (
            SELECT oa.amigo
              FROM splitbill.ordens o
              JOIN splitbill.ordem_amigos oa ON oa.ordem_id = o.id
             WHERE o.evento_id = ev.id
             UNION
            SELECT ofr.quem
              FROM splitbill.ofertas ofr
             WHERE ofr.evento_id = ev.id
             UNION
            SELECT op.amigo
              FROM splitbill.ofertas ofr2
              JOIN splitbill.oferta_para op ON op.oferta_id = ofr2.id
             WHERE ofr2.evento_id = ev.id
             UNION
            SELECT ev.pagador
      ) p ON TRUE
     GROUP BY ev.id
  ) sub
 WHERE sub.id = e.id
   AND e.amigos IS NULL;

-- Nota: NÃO é preciso mexer em GRANTs nem em POLICIES. As colunas entram nas
-- políticas que já existem em splitbill.eventos (RLS é por linha, não por
-- coluna) — confirma na mesma com:
--   SELECT polname, polcmd FROM pg_policy
--    WHERE polrelid = 'splitbill.eventos'::regclass;
