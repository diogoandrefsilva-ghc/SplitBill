-- =====================================================================
-- SplitBill — Migração: utilizador pode declarar "já paguei" (dívida pendente
-- ou já prescrita); o admin, o substituto OU o pagador (tesoureiro) desse
-- evento em específico confirmam ou rejeitam.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- registar um pagamento sempre foi coisa de admin/substituto — um convocado
-- normal não tinha como dizer "já paguei isto" sem mandar mensagem à parte.
-- Isto dá-lhe essa via, mas SEM lhe dar acesso de escrita geral à tabela
-- `pagamentos`: só pode inserir uma linha tipo='pendente' para SI PRÓPRIO
-- (nunca em nome de outra pessoa), e só pode apagar essa linha (cancelar o
-- próprio pedido) — nunca confirmá-la.
--
-- Confirmar/rejeitar é do admin (escrita total já existente em `pagamentos`)
-- e do substituto (idem, via a política já existente). Além destes, o
-- PAGADOR do evento — quem levou o dinheiro à mesa, `eventos.pagador` — pode
-- também confirmar/rejeitar, mas só os pedidos DO(S) EVENTO(S) que ele
-- próprio pagou: é dinheiro dele a ser-lhe devolvido, faz sentido ser ele a
-- validar sem precisar do admin. Não ganha acesso a mais nada em
-- `pagamentos` (nem aos pedidos de outros eventos).
--
-- COMO FUNCIONA (do lado da app, ver app.js):
--   · tipo='pendente' NÃO abate a dívida em calcularSaldos() — só quando
--     alguém com permissão confirma é que vira tipo='evento' (PATCH).
--   · nova coluna `pagamentos.declarado_por` identifica quem fez o pedido —
--     é o que permite ao próprio cancelá-lo, e a quem confirma ver quem foi.
--   · confirmar também remove uma eventual prescrição anterior do mesmo
--     evento/pessoa (DELETE) — o utilizador estava a corrigi-la.
--
-- Sem esta migração a app funciona à mesma: PAGAMENTOS_PENDENTE_COL fica
-- false, os botões "Já paguei?" / "declarar pagamento" escondem-se, e a
-- consola avisa. Nada rebenta.
-- =====================================================================

ALTER TABLE splitbill.pagamentos
  ADD COLUMN IF NOT EXISTS declarado_por text;

COMMENT ON COLUMN splitbill.pagamentos.declarado_por IS
  'Email de quem declarou este pagamento (tipo=''pendente''), por confirmar '
  'pelo admin/substituto/pagador. NULL para pagamentos registados pelo '
  'admin/substituto pelo caminho normal. É o que autoriza o próprio a '
  'cancelar SÓ este pedido.';

-- Sou o pagador (tesoureiro) deste evento? (equivalência amigo↔conta via
-- amigo_users, mesmo padrão de db/ordens-proprias.sql).
CREATE OR REPLACE FUNCTION splitbill.eh_pagador_evento(p_evento_id bigint)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM splitbill.eventos e
      JOIN splitbill.amigo_users au ON au.amigo = e.pagador
     WHERE e.id = p_evento_id
       AND lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

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

-- Cancelar o próprio pedido ainda pendente (antes de alguém decidir).
DROP POLICY IF EXISTS pagamentos_delete_pendente_propria ON splitbill.pagamentos;
CREATE POLICY pagamentos_delete_pendente_propria ON splitbill.pagamentos
  FOR DELETE TO authenticated
  USING (
    tipo = 'pendente'
    AND declarado_por = (auth.jwt() ->> 'email')
  );

-- O pagador confirma um pedido pendente DO SEU evento: só pode mudar
-- tipo='pendente' → 'evento', e só nesse evento. Não pode tocar em mais
-- nenhuma coluna de forma diferente disto nem noutro evento.
DROP POLICY IF EXISTS pagamentos_update_confirmar_pagador ON splitbill.pagamentos;
CREATE POLICY pagamentos_update_confirmar_pagador ON splitbill.pagamentos
  FOR UPDATE TO authenticated
  USING (
    tipo = 'pendente'
    AND splitbill.eh_pagador_evento(evento_id)
  )
  WITH CHECK (
    tipo = 'evento'
    AND splitbill.eh_pagador_evento(evento_id)
  );

-- O pagador rejeita um pedido (apaga a linha 'pendente') ou remove uma
-- prescrição superada ao confirmar outro pedido do mesmo evento/pessoa —
-- ambos os casos são gestão do que ele próprio tem por receber, nunca de um
-- pagamento já confirmado ('evento').
DROP POLICY IF EXISTS pagamentos_delete_pagador ON splitbill.pagamentos;
CREATE POLICY pagamentos_delete_pagador ON splitbill.pagamentos
  FOR DELETE TO authenticated
  USING (
    tipo IN ('pendente', 'prescricao')
    AND splitbill.eh_pagador_evento(evento_id)
  );

-- Nota: NÃO mexe em GRANTs nem nas políticas do admin/substituto que já
-- existem em `pagamentos`. Se a escrita ainda assim falhar, confirma com
-- db/diagnostico-escrita.sql (query 1) se estas políticas ficaram
-- registadas e se há uma equivalência amigo_users para a conta em causa.
-- =====================================================================
