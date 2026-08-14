-- =====================================================================
-- SplitBill — Migração: utilizador pode declarar "já paguei" (dívida pendente
-- ou já prescrita), fica por confirmar pelo admin.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- registar um pagamento sempre foi coisa de admin/substituto — um convocado
-- normal não tinha como dizer "já paguei isto" sem mandar mensagem à parte.
-- Isto dá-lhe essa via, mas SEM lhe dar acesso de escrita geral à tabela
-- `pagamentos`: só pode inserir uma linha tipo='pendente' para SI PRÓPRIO
-- (nunca em nome de outra pessoa), e só pode apagar essa linha (cancelar o
-- próprio pedido) — nunca confirmá-la. Confirmar/rejeitar continua a ser só
-- do admin, que já tem escrita total em `pagamentos` (política existente).
--
-- COMO FUNCIONA (do lado da app, ver app.js):
--   · tipo='pendente' NÃO abate a dívida em calcularSaldos() — só quando o
--     admin confirma é que vira tipo='evento' (PATCH, dentro da política de
--     admin já existente, não precisa de política nova).
--   · nova coluna `pagamentos.declarado_por` identifica quem fez o pedido —
--     é o que permite ao próprio cancelá-lo, e ao admin ver quem foi.
--
-- Sem esta migração a app funciona à mesma: PAGAMENTOS_PENDENTE_COL fica
-- false, os botões "Já paguei?" / "declarar pagamento" escondem-se, e a
-- consola avisa. Nada rebenta.
-- =====================================================================

ALTER TABLE splitbill.pagamentos
  ADD COLUMN IF NOT EXISTS declarado_por text;

COMMENT ON COLUMN splitbill.pagamentos.declarado_por IS
  'Email de quem declarou este pagamento (tipo=''pendente''), por confirmar '
  'pelo admin. NULL para pagamentos registados pelo admin/substituto pelo '
  'caminho normal. É o que autoriza o próprio a cancelar SÓ este pedido.';

-- Inserir um pedido de pagamento próprio: só tipo='pendente', só para o
-- "amigo" equivalente à conta autenticada (amigo_users), e declarado_por tem
-- de ser o email da própria sessão (não se pode declarar em nome de outrem).
DROP POLICY IF EXISTS pagamentos_insert_pendente_propria ON splitbill.pagamentos;
CREATE POLICY pagamentos_insert_pendente_propria ON splitbill.pagamentos
  FOR INSERT TO authenticated
  WITH CHECK (
    tipo = 'pendente'
    AND declarado_por = (auth.jwt() ->> 'email')
    AND EXISTS (
      SELECT 1 FROM splitbill.amigo_users au
       WHERE au.amigo = pagamentos.pessoa
         AND lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

-- Cancelar o próprio pedido ainda pendente (antes do admin decidir).
DROP POLICY IF EXISTS pagamentos_delete_pendente_propria ON splitbill.pagamentos;
CREATE POLICY pagamentos_delete_pendente_propria ON splitbill.pagamentos
  FOR DELETE TO authenticated
  USING (
    tipo = 'pendente'
    AND declarado_por = (auth.jwt() ->> 'email')
  );

-- Nota: NÃO mexe em GRANTs nem nas políticas do admin/substituto que já
-- existem em `pagamentos` — são as que tratam do confirmar (PATCH tipo=
-- 'evento') e do rejeitar (DELETE). Se a escrita ainda assim falhar, confirma
-- com db/diagnostico-escrita.sql (query 1) se estas políticas ficaram
-- registadas e se há uma equivalência amigo_users para a conta em causa.
-- =====================================================================
