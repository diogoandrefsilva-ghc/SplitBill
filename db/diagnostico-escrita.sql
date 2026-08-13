-- =====================================================================
-- SplitBill — Diagnóstico: "a leitura funciona, a escrita não".
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É SÓ DE LEITURA: nenhuma query aqui altera dados, políticas ou permissões.
--
-- Serve de par ao botão "🩺 Diagnóstico da BD" das Definições da app: o botão
-- diz QUAL a operação que parte (visto do browser), estas queries dizem PORQUÊ
-- (visto do servidor).
--
-- A causa habitual de a leitura passar e a escrita não é uma política RLS que
-- só cobre SELECT. Atenção ao caso que apanha toda a gente: a app grava com
-- UPSERT (POST + `Prefer: resolution=merge-duplicates`), que no Postgres é
-- INSERT ... ON CONFLICT DO UPDATE — e isso exige política de INSERT **e** de
-- UPDATE. Só com a de INSERT, criar de raiz funciona e regravar rebenta.
-- =====================================================================

-- 1) Que políticas existem, por tabela e por comando?
--    polcmd: r = SELECT · a = INSERT · w = UPDATE · d = DELETE · * = ALL
SELECT c.relname                AS tabela,
       p.polname                AS politica,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                     WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                     ELSE 'ALL' END AS comando,
       pg_get_expr(p.polqual,      p.polrelid) AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'splitbill'
 ORDER BY c.relname, comando, p.polname;

-- 2) Resumo: que comandos ficam DESCOBERTOS em cada tabela?
--    Uma tabela com RLS activo e sem política para um comando bloqueia-o
--    sempre — é exactamente o sintoma "só a escrita falha".
SELECT c.relname AS tabela,
       c.relrowsecurity AS rls_activo,
       bool_or(p.polcmd IN ('r','*')) AS tem_select,
       bool_or(p.polcmd IN ('a','*')) AS tem_insert,
       bool_or(p.polcmd IN ('w','*')) AS tem_update,
       bool_or(p.polcmd IN ('d','*')) AS tem_delete
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
 WHERE n.nspname = 'splitbill' AND c.relkind = 'r'
 GROUP BY c.relname, c.relrowsecurity
 ORDER BY c.relname;

-- 3) GRANTs do role `authenticated` (a RLS só entra depois do GRANT passar;
--    sem GRANT INSERT/UPDATE/DELETE o pedido morre antes das políticas).
SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'splitbill' AND grantee = 'authenticated'
 ORDER BY table_name, privilege_type;

-- 4) Colunas que a app escreve — confirmar que existem todas.
--    eventos: id, descricao, data, total_fatura, pagador, substituto_email, fatura
--    ordens:  id, evento_id, item, quantidade, preco_unitario, preco_total, hora
SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'splitbill'
   AND table_name IN ('eventos','ordens','ordem_amigos','ofertas','oferta_para','pagamentos')
 ORDER BY table_name, ordinal_position;

-- 5) Chaves estrangeiras: se `ordens.evento_id` aponta para `eventos.id`, uma
--    falha a gravar o evento faz as ordens rebentarem a seguir com o código
--    23503. O erro que se vê é o derivado, não o original.
SELECT con.conname AS constraint_name,
       c.relname   AS tabela,
       pg_get_constraintdef(con.oid) AS definicao
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'splitbill' AND con.contype = 'f'
 ORDER BY c.relname;

-- =====================================================================
-- COMO CORRIGIR (não corras nada disto sem veres primeiro o que falta acima)
--
-- Falta a política de UPDATE numa tabela cujo INSERT já funciona — o caso do
-- upsert. Reaproveita a MESMA condição da política de INSERT que a query 1
-- mostrou (não inventes uma nova, senão abres um buraco):
--
--   CREATE POLICY "<nome> update" ON splitbill.<tabela>
--     FOR UPDATE TO authenticated
--     USING      ( <a mesma condição do with_check do INSERT> )
--     WITH CHECK ( <a mesma condição do with_check do INSERT> );
--
-- Falta o GRANT (query 3 sem INSERT/UPDATE/DELETE):
--
--   GRANT INSERT, UPDATE, DELETE ON splitbill.<tabela> TO authenticated;
--
-- Depois de corrigir, volta a correr o "🩺 Diagnóstico da BD" na app: tem de
-- ficar tudo a verde antes de dar o problema por resolvido.
-- =====================================================================
