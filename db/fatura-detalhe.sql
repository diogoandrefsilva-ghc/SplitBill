-- =====================================================================
-- SplitBill — Migração: detalhe da fatura do restaurante, artigo a artigo.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O QUE É: quando se importa a fatura (📷 Importar fatura → Edge Function
-- `fatura-restaurante` → Gemini), o que o modelo leu deixa de viver só em
-- memória e passa a ficar guardado NO EVENTO. É o registo do que a casa
-- cobrou — permite reabrir a conferência artigo a artigo meses depois sem
-- ter de fotografar o talão outra vez.
--
-- PORQUÊ UMA COLUNA jsonb E NÃO TABELAS NOVAS:
--   · herda as políticas RLS de `eventos` — quem pode editar o evento pode
--     gravar a fatura, quem pode lê-lo pode vê-la. Zero políticas novas,
--     zero risco de abrir um buraco por engano.
--   · o detalhe nunca é consultado relacionalmente (não há relatórios por
--     linha de fatura); é sempre lido inteiro, com o evento.
--   · o upsert do evento que já existe passa a levar mais um campo — não é
--     preciso sincronizar linhas nem podar órfãos.
--
-- FORMATO do jsonb (o que a app escreve e lê):
--   {
--     "restaurante": "Tasca do Zé",       -- pode ser ""
--     "data":        "2026-08-01",        -- data impressa; pode ser ""
--     "total":       25.80,               -- total impresso; null se ilegível
--     "semPreco":    0,                   -- linhas descartadas por não ter preço
--     "lidaEm":      "2026-08-02T20:14:03.221Z",
--     "linhas": [ {"nome":"Imperial","qtd":4,"unit":1.50,"total":6.00}, ... ]
--   }
-- `nome` é o nome como veio IMPRESSO na fatura. A correspondência ao artigo
-- do menu é recalculada pela app a cada abertura (matching difuso), de
-- propósito: se o menu do evento mudar, a conferência acompanha.
--
-- Sem esta migração a app funciona à mesma: `FATURA_COL` fica a false, a
-- fatura guarda-se só no localStorage do dispositivo e a app avisa na
-- consola. Nada rebenta — apenas o detalhe não viaja entre telemóveis.
-- =====================================================================

ALTER TABLE splitbill.eventos
  ADD COLUMN IF NOT EXISTS fatura jsonb;

COMMENT ON COLUMN splitbill.eventos.fatura IS
  'Detalhe da fatura lida por OCR (Edge Function fatura-restaurante): '
  '{restaurante, data, total, semPreco, lidaEm, linhas:[{nome,qtd,unit,total}]}. '
  'NULL = evento sem fatura importada.';

-- Nota: NÃO é preciso mexer em GRANTs nem em POLICIES. A coluna entra nas
-- políticas que já existem em splitbill.eventos (RLS é por linha, não por
-- coluna) — confirma na mesma com:
--   SELECT polname, polcmd FROM pg_policy
--    WHERE polrelid = 'splitbill.eventos'::regclass;
