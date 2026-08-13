-- =====================================================================
-- SplitBill — Inspeção completa da BD. SÓ DE LEITURA.
-- Correr no SQL Editor do Supabase e copiar o resultado.
--
-- É UMA ÚNICA query de propósito: o SQL Editor do Supabase só mostra o
-- resultado da última instrução, por isso está tudo reunido numa tabela
-- com três colunas (n · seccao · detalhe), pronta a copiar inteira.
--
-- NÃO devolve conteúdo pessoal: não há nomes de amigos, emails nem valores
-- de contas. Só estrutura (colunas, tipos, chaves, políticas, permissões),
-- contagens de linhas e intervalos de ids. A única exceção possível é o
-- texto das políticas/funções, que pode conter o email do administrador —
-- esse já está à vista no app.js.
-- =====================================================================

WITH tabelas AS (
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'splitbill' AND c.relkind = 'r'
),
-- Contagem de linhas por tabela sem SQL dinâmico solto: query_to_xml corre
-- a contagem tabela a tabela e devolve o resultado como xml.
contagens AS (
    SELECT t.relname,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM splitbill.%I', t.relname),
                               false, true, '')))[1]::text::bigint AS n_linhas
      FROM tabelas t
),
-- Intervalo de valores de cada coluna de id: mostra se os ids existentes são
-- pequenos (sequência) ou grandes (Date.now(), 13 dígitos).
ids AS (
    SELECT c.table_name, c.column_name, c.data_type, v.mn, v.mx
      FROM information_schema.columns c
      JOIN tabelas t ON t.relname = c.table_name
      CROSS JOIN LATERAL (
          SELECT (xpath('/row/mn/text()', x))[1]::text AS mn,
                 (xpath('/row/mx/text()', x))[1]::text AS mx
            FROM query_to_xml(format('SELECT min(%I) AS mn, max(%I) AS mx FROM splitbill.%I',
                                     c.column_name, c.column_name, c.table_name),
                              false, true, '') AS x
      ) v
     WHERE c.table_schema = 'splitbill'
       AND (c.column_name = 'id' OR c.column_name ~ '_id$')
       AND c.data_type IN ('integer', 'bigint', 'smallint')
)
SELECT r.n, r.seccao, r.detalhe FROM (

    SELECT 1 AS n, 'COLUNAS' AS seccao,
           c.table_name || '.' || c.column_name || ' :: ' || c.data_type
           || CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
           || COALESCE(' DEFAULT ' || c.column_default, '')
           || CASE WHEN c.is_identity = 'YES' THEN ' [identity]' ELSE '' END AS detalhe,
           c.table_name || lpad(c.ordinal_position::text, 3, '0') AS ordem
      FROM information_schema.columns c
      JOIN tabelas t ON t.relname = c.table_name
     WHERE c.table_schema = 'splitbill'

    UNION ALL
    SELECT 2, 'CHAVES E RESTRIÇÕES',
           t.relname || ' · ' || con.conname || ' · ' || pg_get_constraintdef(con.oid),
           t.relname || con.conname
      FROM pg_constraint con
      JOIN tabelas t ON t.oid = con.conrelid

    UNION ALL
    SELECT 3, 'RLS ACTIVO',
           t.relname || ' · rls=' || t.relrowsecurity || ' · force=' || t.relforcerowsecurity
           || ' · políticas=' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = t.oid),
           t.relname
      FROM tabelas t

    UNION ALL
    SELECT 4, 'POLÍTICAS',
           t.relname || ' · ' || p.polname
           || ' · ' || CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                     WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                                     ELSE 'ALL' END
           || ' · roles=' || COALESCE((SELECT string_agg(pg_get_userbyid(o), ',')
                                         FROM unnest(p.polroles) AS o), 'public')
           || ' · USING '     || COALESCE(pg_get_expr(p.polqual,      p.polrelid), '—')
           || ' · WITHCHECK ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '—'),
           t.relname || p.polname
      FROM pg_policy p
      JOIN tabelas t ON t.oid = p.polrelid

    UNION ALL
    SELECT 5, 'PERMISSÕES (GRANTS)',
           g.table_name || ' · ' || g.grantee || ' · ' || string_agg(g.privilege_type, ',' ORDER BY g.privilege_type),
           g.table_name || g.grantee
      FROM information_schema.role_table_grants g
     WHERE g.table_schema = 'splitbill'
       AND g.grantee IN ('anon', 'authenticated', 'service_role')
     GROUP BY g.table_name, g.grantee

    UNION ALL
    SELECT 6, 'LINHAS POR TABELA',
           c.relname || ' · ' || COALESCE(c.n_linhas::text, '?') || ' linha(s)',
           c.relname
      FROM contagens c

    UNION ALL
    SELECT 7, 'INTERVALO DOS IDS',
           i.table_name || '.' || i.column_name || ' (' || i.data_type || ')'
           || ' min=' || COALESCE(i.mn, '—') || ' max=' || COALESCE(i.mx, '—')
           || CASE WHEN i.data_type = 'integer'
                   THEN '  ⛔ integer: Date.now() (13 dígitos) NÃO cabe'
                   ELSE '' END,
           i.table_name || i.column_name
      FROM ids i

    UNION ALL
    SELECT 8, 'FUNÇÕES',
           p.proname || '(' || pg_get_function_arguments(p.oid) || ') -> '
           || pg_get_function_result(p.oid) || '  ::  '
           || replace(COALESCE(p.prosrc, ''), E'\n', ' '),
           p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'splitbill'
        OR (n.nspname = 'public' AND p.proname ~ 'is_allowed|is_admin|pode_editar')

    UNION ALL
    SELECT 9, 'TRIGGERS',
           t.relname || ' · ' || tg.tgname || ' · ' || pg_get_triggerdef(tg.oid),
           t.relname || tg.tgname
      FROM pg_trigger tg
      JOIN tabelas t ON t.oid = tg.tgrelid
     WHERE NOT tg.tgisinternal

) r
ORDER BY r.n, r.ordem;
