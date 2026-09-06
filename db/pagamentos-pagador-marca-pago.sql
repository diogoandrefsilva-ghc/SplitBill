-- =====================================================================
-- SplitBill — Migração: o pagador (tesoureiro) de um evento pode marcar
-- diretamente como paga (ou prescrita) a dívida de outro convocado nesse
-- evento, sem precisar que a pessoa tenha declarado "Já paguei?" primeiro.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- db/pagamentos-pendentes.sql já deixava o pagador CONFIRMAR (UPDATE) um
-- pedido "já paguei" pendente do seu próprio evento, mas não o deixava
-- INSERIR diretamente um pagamento tipo='evento' (nem uma prescrição,
-- tipo='prescricao') quando ninguém declarou nada — ficava só com o botão
-- "Lembrar" no ecrã de Saldos, e tanto o "Dar como pago" como o
-- "Prescrever dívida" (app.js: podeRegistarDiretamente, usada em
-- registarPagamento()/prescreverDivida()) falhavam por RLS ao gravar. Esta
-- migração dá-lhe essa mesma via de admin/substituto, mas só para o(s)
-- evento(s) em que ele próprio é o pagador (`eventos.pagador`).
--
-- Continua sem lhe dar acesso geral à tabela: não pode inserir para
-- eventos que não são dele, nem mexer em mais nenhuma política existente
-- (a de UPDATE/DELETE do pagador, ou as do admin/substituto).
--
-- Sem esta migração a app degrada sem rebentar: o botão "Dar como pago" do
-- pagador mostra o erro de escrita da BD e nada se grava; o admin e o
-- substituto continuam a funcionar como sempre (política pg_ins já
-- existente). Depende de splitbill.eh_pagador_evento(), criada em
-- db/pagamentos-pendentes.sql — corre essa primeiro se ainda não tiver
-- sido corrida.
-- =====================================================================

DROP POLICY IF EXISTS pagamentos_insert_evento_pagador ON splitbill.pagamentos;
CREATE POLICY pagamentos_insert_evento_pagador ON splitbill.pagamentos
  FOR INSERT TO authenticated
  WITH CHECK (
    tipo IN ('evento', 'prescricao')
    AND splitbill.eh_pagador_evento(evento_id)
  );
