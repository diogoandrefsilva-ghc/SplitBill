-- =====================================================================
-- SplitBill — Migração: colunas de id de `integer` para `bigint`.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE ISTO RESOLVE
-- A app gera os ids com `Date.now()` — milissegundos desde 1970, hoje um
-- número de 13 dígitos (ex.: 1786612183633). O `integer` do Postgres (int4)
-- só vai até 2 147 483 647, ~2,1 mil milhões. Todos os INSERT de eventos,
-- ordens, ofertas e pagamentos eram rejeitados com:
--
--   22003 — value "1786612183633" is out of range for type integer
--
-- A leitura funcionava (as linhas antigas, com ids pequenos, lêem-se bem), a
-- escrita não — daí o "Falha ao guardar no servidor" a cada ordem nova.
-- `bigint` (int8) vai até ~9,2 × 10^18: dá para os ids em milissegundos
-- durante os próximos ~292 milhões de anos.
--
-- O QUE FAZ
--   1. guarda a definição das POLÍTICAS RLS e larga-as. O Postgres recusa
--      mudar o tipo de uma coluna citada numa política ("cannot alter type of
--      a column used in a policy definition") — e as políticas do SplitBill
--      citam-nas todas, via pode_editar_evento(evento_id::bigint) e afins;
--   2. o mesmo para as CHAVES ESTRANGEIRAS;
--   3. muda para bigint as colunas `id` e `%_id` das tabelas do SplitBill
--      que ainda estejam em integer;
--   4. repõe chaves estrangeiras e políticas exactamente como estavam.
--
-- Os casts `::bigint` que as políticas já fazem passam a ser inofensivos
-- (converter bigint para bigint não faz nada), por isso as políticas voltam
-- letra por letra — não é preciso reescrevê-las.
--
-- Corre tudo numa transação: ou passa inteiro, ou não muda nada. Não toca em
-- dados: os valores antigos cabem todos em bigint.
--
-- TESTADO em PostgreSQL 16 contra uma réplica fiel deste schema — mesmas
-- tabelas, mesmas 30 políticas, mesmas funções is_admin/is_allowed/
-- pode_editar_*, mesmo trigger protege_substituto, e ids `integer` a par de
-- `bigint`/`identity`. No fim: as chaves estrangeiras voltam com o ON DELETE
-- CASCADE intacto, as 30 políticas voltam idênticas, as linhas mantêm-se, e a
-- segunda passagem não faz nada.
--
-- NOTA: se alguma VIEW depender destas colunas, o ALTER falha e o Postgres
-- diz qual — larga a view, corre isto, recria a view.
-- =====================================================================

DO $$
DECLARE
    tabelas CONSTANT text[] := ARRAY[
        'eventos', 'ordens', 'ordem_amigos', 'ofertas',
        'oferta_para', 'pagamentos', 'eventos_divisao'
    ];
    r        record;
    fks      text[] := '{}';
    pols     text[] := '{}';
    ddl      text;
    mudadas  int := 0;
BEGIN
    -- 1) Largar as políticas RLS, guardando o comando que as recria.
    --    (O RLS em si fica ligado; só as políticas saem, dentro da transação.)
    FOR r IN
        SELECT p.polname, t.relname, p.polpermissive, p.polcmd,
               pg_get_expr(p.polqual,      p.polrelid) AS q,
               pg_get_expr(p.polwithcheck, p.polrelid) AS w,
               CASE WHEN 0 = ANY(p.polroles) THEN 'PUBLIC'
                    ELSE (SELECT string_agg(quote_ident(pg_get_userbyid(o)), ', ')
                            FROM unnest(p.polroles) AS o) END AS roles
          FROM pg_policy   p
          JOIN pg_class    t ON t.oid = p.polrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'splitbill'
           AND t.relname = ANY(tabelas)
    LOOP
        pols := pols || format(
            'CREATE POLICY %I ON splitbill.%I AS %s FOR %s TO %s%s%s',
            r.polname, r.relname,
            CASE WHEN r.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
            CASE r.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                          WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                          ELSE 'ALL' END,
            r.roles,
            COALESCE(' USING (' || r.q || ')', ''),
            COALESCE(' WITH CHECK (' || r.w || ')', ''));
        EXECUTE format('DROP POLICY %I ON splitbill.%I', r.polname, r.relname);
    END LOOP;

    -- 2) Largar as FKs, guardando o comando que as recria.
    FOR r IN
        SELECT con.conname, c.relname, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class     c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'splitbill'
           AND con.contype = 'f'
           AND c.relname = ANY(tabelas)
    LOOP
        fks := fks || format('ALTER TABLE splitbill.%I ADD CONSTRAINT %I %s',
                             r.relname, r.conname, r.def);
        EXECUTE format('ALTER TABLE splitbill.%I DROP CONSTRAINT %I',
                       r.relname, r.conname);
    END LOOP;

    -- 3) integer -> bigint nas colunas de id.
    FOR r IN
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'splitbill'
           AND table_name = ANY(tabelas)
           AND data_type = 'integer'
           AND (column_name = 'id' OR column_name ~ '_id$')
    LOOP
        EXECUTE format('ALTER TABLE splitbill.%I ALTER COLUMN %I TYPE bigint',
                       r.table_name, r.column_name);
        RAISE NOTICE 'bigint: splitbill.%.%', r.table_name, r.column_name;
        mudadas := mudadas + 1;
    END LOOP;

    -- 4) Repor FKs e políticas tal e qual estavam.
    FOREACH ddl IN ARRAY fks LOOP
        EXECUTE ddl;
    END LOOP;
    FOREACH ddl IN ARRAY pols LOOP
        EXECUTE ddl;
    END LOOP;

    RAISE NOTICE '% política(s) e % chave(s) estrangeira(s) repostas.',
                 array_length(pols, 1), array_length(fks, 1);
    IF mudadas = 0 THEN
        RAISE NOTICE 'Nada a fazer: as colunas de id já são bigint.';
    ELSE
        RAISE NOTICE '% coluna(s) convertida(s) para bigint.', mudadas;
    END IF;
END $$;

-- Confirmação: todas estas colunas têm de aparecer como `bigint`.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'splitbill'
   AND table_name IN ('eventos','ordens','ordem_amigos','ofertas',
                      'oferta_para','pagamentos','eventos_divisao')
   AND (column_name = 'id' OR column_name ~ '_id$')
 ORDER BY table_name, column_name;
