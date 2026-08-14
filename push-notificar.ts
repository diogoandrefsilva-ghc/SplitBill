// supabase/functions/push-notificar/index.ts
// SplitBill — Envia notificações Web Push (Notification/Push API, sem
// Telegram). Três momentos, todos chamados pela app:
//   'divida'              fecharComFatura() → todos os devedores do evento
//                          que acabou de fechar (fire-and-forget)
//   'pagamento_declarado' declararPagamento() → o pagador/tesoureiro do
//                          evento, quando alguém diz "já paguei"
//                          (fire-and-forget)
//   'lembrete'             enviarLembretePagamento() → o devedor, quando o
//                          credor pede manualmente para o lembrar
//                          (utilizador espera pelo resultado)
//
// Resolve amigo→email via `amigo_users` (mesma tabela usada nas outras
// políticas de equivalência) e manda o push a cada `push_subscriptions`
// dessa pessoa. Subscriptions que já não existem do lado do browser
// (404/410) são apagadas aqui mesmo. O texto da notificação é sempre
// escolhido AQUI (por `tipo`), nunca vindo livre do cliente — só os nomes/
// valores são interpolados.
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy). Por cima disso confirma-se que o email consta de
// `splitbill.allowed_users`, tal como a `fatura-restaurante`.
//
// Secrets necessários (Edge Functions -> Secrets):
//   VAPID_PUBLIC_KEY   par de chaves só para isto (não é a chave do Supabase)
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT      (opcional) "mailto:..."; sem ele usa um valor por omissão
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy push-notificar

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@splitbill.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sbHeaders = {
  apikey: SB_SRV,
  Authorization: `Bearer ${SB_SRV}`,
  "Content-Profile": "splitbill",
  "Accept-Profile": "splitbill",
  "Content-Type": "application/json",
};

async function emailAutorizado(auth: string): Promise<string | null> {
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  });
  if (!u.ok) return null;
  const email = ((await u.json()).email ?? "").toLowerCase();
  if (!email) return null;
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    { headers: sbHeaders },
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0 ? email : null;
}

type Pessoa = { amigo: string; valor: number };
type Tipo = "divida" | "pagamento_declarado" | "lembrete";

function montarMensagem(tipo: Tipo, p: Pessoa, descricao?: string, quem?: string) {
  const suf = descricao ? ` — ${descricao}` : "";
  const valor = p.valor.toFixed(2);
  if (tipo === "pagamento_declarado") {
    return {
      title: "✅ Pagamento declarado",
      body: `${quem || "Alguém"} diz que já te pagou €${valor}${suf} — confirma na app`,
    };
  }
  if (tipo === "lembrete") {
    return {
      title: "🔔 Lembrete de pagamento",
      body: `${quem || "Alguém"} lembra-te que ainda deves €${valor}${suf}`,
    };
  }
  return {
    title: "💸 Nova dívida no SplitBill",
    body: `${p.amigo}, ficaste a dever €${valor}${suf}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!(await emailAutorizado(auth))) return json({ error: "não autorizado" }, 403);

    const { pessoas, descricao, quem, tipo } = (await req.json()) as {
      pessoas?: Pessoa[];
      descricao?: string;
      quem?: string;
      tipo?: Tipo;
    };
    const tipoOk: Tipo = tipo === "pagamento_declarado" || tipo === "lembrete" ? tipo : "divida";
    if (!Array.isArray(pessoas) || pessoas.length === 0) return json({ enviados: 0, falhados: 0 });

    // amigo → email (só os amigos pedidos)
    const nomes = [...new Set(pessoas.map((p) => p.amigo).filter(Boolean))];
    const orList = nomes.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    const eqR = await fetch(
      `${SB_URL}/rest/v1/amigo_users?amigo=in.(${orList})&select=amigo,email`,
      { headers: sbHeaders },
    );
    const equivalencias: { amigo: string; email: string }[] = eqR.ok ? await eqR.json() : [];
    const emailPorAmigo = new Map(equivalencias.map((e) => [e.amigo, e.email.toLowerCase()]));

    const emails = [...new Set(pessoas.map((p) => emailPorAmigo.get(p.amigo)).filter(Boolean))] as string[];
    if (emails.length === 0) return json({ enviados: 0, falhados: 0 });

    const orEmails = emails.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
    const subR = await fetch(
      `${SB_URL}/rest/v1/push_subscriptions?email=in.(${orEmails})&select=endpoint,email,p256dh,auth_key`,
      { headers: sbHeaders },
    );
    const subs: { endpoint: string; email: string; p256dh: string; auth_key: string }[] =
      subR.ok ? await subR.json() : [];

    let enviados = 0;
    let falhados = 0;
    const mortos: string[] = [];

    await Promise.all(
      pessoas.map(async (p) => {
        const email = emailPorAmigo.get(p.amigo);
        if (!email) return;
        const minhasSubs = subs.filter((s) => s.email === email);
        const payload = JSON.stringify({
          ...montarMensagem(tipoOk, p, descricao, quem),
          url: "/SplitBill/",
        });
        await Promise.all(
          minhasSubs.map(async (s) => {
            try {
              await webpush.sendNotification(
                {
                  endpoint: s.endpoint,
                  keys: { p256dh: s.p256dh, auth: s.auth_key },
                },
                payload,
              );
              enviados++;
            } catch (e) {
              const status = (e as { statusCode?: number }).statusCode;
              if (status === 404 || status === 410) mortos.push(s.endpoint);
              falhados++;
            }
          }),
        );
      }),
    );

    if (mortos.length) {
      const orMortos = mortos.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
      await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${orMortos})`, {
        method: "DELETE",
        headers: sbHeaders,
      }).catch(() => {});
    }

    return json({ enviados, falhados });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
