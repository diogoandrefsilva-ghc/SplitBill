-- =====================================================================
-- SplitBill — Migração: configuração da app (splitbill.config) e, com ela,
-- os convocados por defeito de um evento novo.
-- Correr no SQL Editor do Supabase. É IDEMPOTENTE.
--
-- PORQUÊ:
-- até aqui os convocados de um evento novo eram ADIVINHADOS — quem tivesse
-- aparecido em >= 3 dos últimos 10 eventos com consumo (amigosPorDefeito()).
-- Funcionava, mas mudava sozinho conforme quem faltasse, e ninguém percebia
-- porquê. Agora há uma lista fixa, definida pelo admin em Definições, e a
-- heurística fica só como rede de segurança para quando a lista não existe.
--
-- Tabela genérica de chave/valor de propósito: a próxima definição global
-- entra aqui sem migração nova.
--   chave 'convocados_default' -> {"amigos": ["Diogo", "Barrona", ...]}
-- =====================================================================

CREATE TABLE IF NOT EXISTS splitbill.config (
  chave          text        NOT NULL,
  valor          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  CONSTRAINT config_pkey PRIMARY KEY (chave)
);

ALTER TABLE splitbill.config ENABLE ROW LEVEL SECURITY;

-- Ler: qualquer conta com acesso. A app precisa da lista para criar eventos e
-- não há aqui nada de sensível.
DROP POLICY IF EXISTS config_sel ON splitbill.config;
CREATE POLICY config_sel ON splitbill.config FOR SELECT
  USING (splitbill.is_allowed());

-- Escrever: só o admin. É uma definição global da app.
DROP POLICY IF EXISTS config_ins ON splitbill.config;
CREATE POLICY config_ins ON splitbill.config FOR INSERT
  WITH CHECK (splitbill.is_admin());

DROP POLICY IF EXISTS config_upd ON splitbill.config;
CREATE POLICY config_upd ON splitbill.config FOR UPDATE
  USING (splitbill.is_admin()) WITH CHECK (splitbill.is_admin());

GRANT SELECT, INSERT, UPDATE ON splitbill.config TO authenticated;

-- Lista inicial. Só entra se ainda não existir — nunca por cima do que o
-- admin já tenha configurado (daí o ON CONFLICT DO NOTHING).
INSERT INTO splitbill.config (chave, valor)
VALUES ('convocados_default', '{"amigos": ["Diogo", "Barrona", "João Hélder", "Mestre", "Rogélio", "João Paulo", "Luís Pedro", "Filipe"]}'::jsonb)
ON CONFLICT (chave) DO NOTHING;
