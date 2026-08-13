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
--   1. guarda a definição das chaves estrangeiras do schema e larga-as
--      (não se pode mudar o tipo de uma coluna referenciada sem isso);
--   2. muda para bigint as colunas `id` e `%_id` das tabelas do SplitBill
--      que ainda estejam em integer;
--   3. repõe as chaves estrangeiras exactamente como estavam.
--
-- Corre tudo numa transação: ou passa inteiro, ou não muda nada. Não toca em
-- dados (os valores antigos cabem todos em bigint) nem em políticas RLS.
--
-- TESTADO em PostgreSQL 16 contra uma réplica deste schema, nas duas
-- variantes: ids `integer` simples e ids `serial`/`identity`. Em ambas, as
-- chaves estrangeiras voltam com o ON DELETE CASCADE intacto, as políticas
-- RLS ficam na mesma, as linhas antigas mantêm-se, a sequência continua a
-- funcionar, e a segunda passagem não faz nada.
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
    ddl      text;
    mudadas  int := 0;
BEGIN
    -- 1) Largar as FKs, guardando o comando que as recria.
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

    -- 2) integer -> bigint nas colunas de id.
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

    -- 3) Repor as FKs tal e qual estavam.
    FOREACH ddl IN ARRAY fks LOOP
        EXECUTE ddl;
    END LOOP;

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
