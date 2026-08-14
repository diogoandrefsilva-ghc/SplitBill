-- =====================================================================
-- SplitBill — Migração: convocados podem adicionar/editar/apagar a PRÓPRIA
-- ordem num evento em aberto.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- até aqui só o admin e o substituto nomeado podiam mexer nas ordens de um
-- evento (políticas RLS de `ordens`/`ordem_amigos` via pode_editar_evento()).
-- Um convocado normal via a página do evento em modo só-leitura. Isto abre uma
-- fresta: o convocado pode INSERIR a sua própria ordem num evento em aberto, e
-- só pode editar/apagar as ordens que ele próprio criou — nunca as dos outros,
-- e nunca depois de o evento fechar (fatura lançada).
--
-- COMO FUNCIONA:
--   · nova coluna `ordens.criado_por` (email de quem inseriu a linha; NULL
--     para ordens lançadas pelo admin/substituto pelo caminho antigo).
--   · políticas NOVAS e ADITIVAS — o Postgres combina políticas permissivas do
--     mesmo comando com OR, portanto isto não mexe nas políticas do
--     admin/substituto que já existem: só acrescenta mais uma via de acesso.
--   · a app só mostra os controlos de "adicionar ordem" a um convocado sem
--     mais permissões, e só grava a linha dele com um caminho de escrita
--     DIRIGIDO (uma única linha), nunca o caminho do admin (que faz PATCH ao
--     evento inteiro + upsert/prune de TODAS as ordens — esse continua a
--     precisar de pode_editar_evento(), como sempre).
--
-- Sem esta migração a app funciona à mesma: ORDENS_CRIADO_POR_COL fica false,
-- os controlos de "adicionar ordem" continuam escondidos para quem não é
-- admin/substituto (como hoje), e a consola avisa. Nada rebenta.
-- =====================================================================

ALTER TABLE splitbill.ordens
  ADD COLUMN IF NOT EXISTS criado_por text;

COMMENT ON COLUMN splitbill.ordens.criado_por IS
  'Email de quem inseriu esta ordem diretamente (convocado sem ser '
  'admin/substituto). NULL = lançada pelo admin/substituto pelo caminho '
  'normal (PATCH ao evento). É o que autoriza o próprio a editar/apagar SÓ '
  'esta linha, via as políticas *_propria abaixo.';

-- Evento em aberto (sem fatura lançada) — só aí um convocado pode mexer.
CREATE OR REPLACE FUNCTION splitbill.evento_aberto(p_evento_id bigint)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM splitbill.eventos e
     WHERE e.id = p_evento_id AND e.total_fatura IS NULL
  );
$$;

-- A conta autenticada corresponde a um "amigo" convocado deste evento (em
-- aberto)? Usa amigo_users (equivalência amigo↔conta, gerida pelo admin) e a
-- coluna eventos.amigos (convocados, migração db/convocados-menu.sql — sem
-- ela a coluna fica NULL e esta função devolve sempre false, i.e. degrada
-- para "sem permissão", nunca abre uma fresta indevida).
CREATE OR REPLACE FUNCTION splitbill.pode_adicionar_ordem_propria(p_evento_id bigint)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM splitbill.eventos e
      JOIN splitbill.amigo_users au ON e.amigos ? au.amigo
     WHERE e.id = p_evento_id
       AND e.total_fatura IS NULL
       AND lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ordens: inserir/editar/apagar a PRÓPRIA ordem.
DROP POLICY IF EXISTS ordens_insert_propria ON splitbill.ordens;
CREATE POLICY ordens_insert_propria ON splitbill.ordens
  FOR INSERT TO authenticated
  WITH CHECK (
    criado_por = (auth.jwt() ->> 'email')
    AND splitbill.pode_adicionar_ordem_propria(evento_id)
  );

DROP POLICY IF EXISTS ordens_update_propria ON splitbill.ordens;
CREATE POLICY ordens_update_propria ON splitbill.ordens
  FOR UPDATE TO authenticated
  USING (
    criado_por = (auth.jwt() ->> 'email')
    AND splitbill.evento_aberto(evento_id)
  )
  WITH CHECK (
    criado_por = (auth.jwt() ->> 'email')
    AND splitbill.evento_aberto(evento_id)
  );

DROP POLICY IF EXISTS ordens_delete_propria ON splitbill.ordens;
CREATE POLICY ordens_delete_propria ON splitbill.ordens
  FOR DELETE TO authenticated
  USING (
    criado_por = (auth.jwt() ->> 'email')
    AND splitbill.evento_aberto(evento_id)
  );

-- ordem_amigos: filhos da própria ordem (quem consumiu). Autorização por
-- junção ao pai — a linha em si não sabe de quem é.
DROP POLICY IF EXISTS ordem_amigos_insert_propria ON splitbill.ordem_amigos;
CREATE POLICY ordem_amigos_insert_propria ON splitbill.ordem_amigos
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM splitbill.ordens o
       WHERE o.id = ordem_amigos.ordem_id
         AND o.criado_por = (auth.jwt() ->> 'email')
         AND splitbill.evento_aberto(o.evento_id)
    )
  );

DROP POLICY IF EXISTS ordem_amigos_delete_propria ON splitbill.ordem_amigos;
CREATE POLICY ordem_amigos_delete_propria ON splitbill.ordem_amigos
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM splitbill.ordens o
       WHERE o.id = ordem_amigos.ordem_id
         AND o.criado_por = (auth.jwt() ->> 'email')
         AND splitbill.evento_aberto(o.evento_id)
    )
  );

-- Nota: NÃO mexe em GRANTs — o role `authenticated` já tem INSERT/UPDATE/
-- DELETE em `ordens`/`ordem_amigos` (é como o admin/substituto já escrevem
-- hoje). Se mesmo assim a escrita falhar depois de correr isto, confirma com
-- db/diagnostico-escrita.sql (query 1) se as políticas acima ficaram
-- registadas e se `eventos.amigos` está mesmo preenchido para o evento em
-- causa (db/convocados-menu.sql).
-- =====================================================================
