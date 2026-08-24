-- =====================================================================
-- SplitBill — Migração: notificações push (Web Push), sem ser por Telegram.
-- Correr no SQL Editor do Supabase (projeto do SplitBill).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O QUE FAZ:
-- guarda a "push subscription" que o browser gera quando o utilizador ativa
-- notificações (Definições → Ativar notificações). Cada linha é um par
-- endpoint+chaves ligado à conta (email) que o gerou — o mesmo utilizador
-- pode ter várias linhas (um por telemóvel/instalação da PWA).
--
-- QUEM ENVIA: a Edge Function `push-notificar` (service role, bypassa RLS),
-- chamada pela app no fim de fecharComFatura() — é aí que nascem dívidas
-- novas. Resolve amigo→email via `amigo_users` (mesma tabela já usada para
-- "quem sou eu" nas outras políticas) e manda o push a cada subscription
-- dessa pessoa.
--
-- Sem esta migração a app funciona à mesma: PUSH_COL fica false, o botão
-- "Ativar notificações" esconde-se, e a consola avisa. Nada rebenta.
-- =====================================================================

CREATE TABLE IF NOT EXISTS splitbill.push_subscriptions (
  endpoint   text PRIMARY KEY,
  email      text NOT NULL,
  p256dh     text NOT NULL,
  auth_key   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_email_idx
  ON splitbill.push_subscriptions (lower(email));

ALTER TABLE splitbill.push_subscriptions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON splitbill.push_subscriptions TO authenticated;

-- Cada um só vê/gere as próprias subscriptions (a Edge Function usa a
-- service role e não passa por aqui).
DROP POLICY IF EXISTS push_subscriptions_select_propria ON splitbill.push_subscriptions;
CREATE POLICY push_subscriptions_select_propria ON splitbill.push_subscriptions
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- INSERT/UPDATE cobrem o upsert que a app faz (Prefer: resolution=merge-duplicates
-- pela PK `endpoint`) sempre que subscreve neste dispositivo.
DROP POLICY IF EXISTS push_subscriptions_insert_propria ON splitbill.push_subscriptions;
CREATE POLICY push_subscriptions_insert_propria ON splitbill.push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

DROP POLICY IF EXISTS push_subscriptions_update_propria ON splitbill.push_subscriptions;
CREATE POLICY push_subscriptions_update_propria ON splitbill.push_subscriptions
  FOR UPDATE TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

DROP POLICY IF EXISTS push_subscriptions_delete_propria ON splitbill.push_subscriptions;
CREATE POLICY push_subscriptions_delete_propria ON splitbill.push_subscriptions
  FOR DELETE TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Policy extra (permissiva, soma-se à de cima com OR): o admin também vê todas
-- as linhas, para o painel "Equivalências amigo ↔ conta" mostrar o sininho de
-- quem tem notificações ativas. Sem correr isto, esse painel só "vê" a
-- subscription do próprio admin — degrada, não rebenta.
DROP POLICY IF EXISTS push_subscriptions_select_admin ON splitbill.push_subscriptions;
CREATE POLICY push_subscriptions_select_admin ON splitbill.push_subscriptions
  FOR SELECT TO authenticated
  USING (splitbill.is_admin());
-- =====================================================================
