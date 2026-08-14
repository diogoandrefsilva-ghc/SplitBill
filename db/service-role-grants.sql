-- =====================================================================
-- SplitBill — Migração: dar à `service_role` acesso ao schema `splitbill`.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O PROBLEMA QUE RESOLVE:
-- a Edge Function `fatura-restaurante` usa a `service_role` (chave secreta,
-- só do lado do servidor) para verificar se quem pediu a leitura da fatura
-- consta de `splitbill.allowed_users` — de propósito, para não depender da
-- sessão do utilizador nessa verificação. Mas quando o schema `splitbill`
-- foi criado, os GRANTs só foram dados a `anon`/`authenticated` (é o que a
-- app usa) — a `service_role` ficou de fora. Resultado: mesmo tendo
-- `BYPASSRLS`, a `service_role` continua sujeita aos privilégios SQL
-- normais, e sem GRANT nenhum a consulta a `allowed_users` vinha sempre
-- 403 ("permission denied"). Sintoma: importar a fatura por foto dava
-- sempre "não autorizado", mesmo para quem estava na lista.
--
-- Sem esta migração qualquer função/uso futuro da `service_role` contra o
-- schema `splitbill` continua a falhar da mesma forma.
-- =====================================================================

GRANT USAGE ON SCHEMA splitbill TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA splitbill TO service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA splitbill TO service_role;

-- Para tabelas splitbill futuras herdarem o mesmo acesso automaticamente.
ALTER DEFAULT PRIVILEGES IN SCHEMA splitbill
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA splitbill
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- Nota: a `service_role` já tem BYPASSRLS (confirmado em pg_roles), por isso
-- isto não abre políticas novas nem muda o que o browser consegue fazer —
-- só desbloqueia o acesso direto que as Edge Functions já deviam ter.
