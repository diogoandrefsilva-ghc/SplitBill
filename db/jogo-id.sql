-- =====================================================================
-- SplitBill — Migração: `eventos.jogo_id`, a ligação ao jogo do Goals.
-- Correr no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- PORQUÊ ISTO EXISTE:
-- o calendário passou a ter um dono só — `goals.jogos`, alimentado pela app
-- Goals (é lá que se pergunta à IA e é lá que o admin confirma linha a linha).
-- O SplitBill deixou de ter sincronização por IA: lê os jogos de lá e guarda
-- cá apenas o MÍNIMO — uma linha em `eventos` por jogo em Alvalade — porque é
-- nela que vivem as coisas que só existem nesta app: quem vai ao jogo, quem
-- vai ao Sá, os convocados, o menu, o tesoureiro, as ordens e a fatura.
--
-- `jogo_id` é o que liga as duas pontas. Antes disto a correspondência era
-- adivinhada por nome+data (`_calPontuarEv`): funcionava, mas um jogo
-- remarcado ou renomeado no Goals podia deixar de casar, e o evento ficava
-- órfão — ou, pior, duplicado na sincronização seguinte.
--
-- PORQUE NÃO É UMA FOREIGN KEY:
-- `goals.jogos` é de outro schema e de outra app. Uma FK deixaria um jogo
-- apagado no Goals a mexer (ou a bloquear) linhas desta app, que guardam
-- dinheiro e presenças. Aqui um `jogo_id` que já não existe do outro lado é
-- só um evento que deixa de ter ficha — degrada, não rebenta.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS jogo_id bigint;

COMMENT ON COLUMN splitbill.eventos.jogo_id IS
  'id da linha em goals.jogos que este evento representa. Sem FK de propósito: ver db/jogo-id.sql.';

-- Dois eventos a apontar para o mesmo jogo é sempre bug (duas sessões a
-- sincronizar ao mesmo tempo, por exemplo). O índice parcial é a rede: a
-- segunda escrita falha em vez de duplicar o dia de jogo.
CREATE UNIQUE INDEX IF NOT EXISTS eventos_jogo_id_uniq
  ON splitbill.eventos (jogo_id) WHERE jogo_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- RETROACTIVO: liga os eventos que já existem ao jogo respectivo.
-- Conservador de propósito — só liga quando a data bate certo E existe
-- exactamente UM jogo em Alvalade nesse dia. Havendo dúvida não liga
-- nenhum: um evento sem ligação continua a funcionar (a app cai na
-- correspondência por nome+data), um evento ligado ao jogo errado não.
-- ---------------------------------------------------------------------
WITH alvalade AS (
  SELECT id, data
  FROM goals.jogos
  WHERE por_definir = false
    AND (local = 'Casa' OR estadio ILIKE '%alvalade%')
), unicos AS (
  SELECT data, min(id) AS id
  FROM alvalade
  GROUP BY data
  HAVING count(*) = 1
)
UPDATE splitbill.eventos e
SET jogo_id = u.id
FROM unicos u
WHERE e.jogo_id IS NULL
  AND e.data ~ '^\d{2}/\d{2}/\d{4}$'
  AND to_date(e.data, 'DD/MM/YYYY') = u.data
  -- não pisar um jogo já reclamado por outro evento
  AND NOT EXISTS (SELECT 1 FROM splitbill.eventos x WHERE x.jogo_id = u.id);
-- =====================================================================
