// supabase/functions/push-notificar/index.ts
// SplitBill — Envia notificações Web Push (Notification/Push API, sem
// Telegram). Sete momentos, todos chamados pela app:
//   'divida'              fecharComFatura() → todos os devedores do evento
//                          que acabou de fechar (fire-and-forget)
//   'pagamento_declarado' declararPagamento() → o pagador/tesoureiro do
//                          evento, quando alguém diz "já paguei"
//                          (fire-and-forget)
//   'lembrete'             enviarLembretePagamento() → o devedor, quando o
//                          credor pede manualmente para o lembrar
//                          (utilizador espera pelo resultado)
//   'pedido_acesso'        sbSolicitarAcesso() → avisa o ADMIN_EMAIL quando
//                          alguém pede acesso à app pela primeira vez
//                          (fire-and-forget)
//   'gamebox'              marcarPresencaJogo(false) → o grupo todo menos quem
//                          desistiu: há um lugar na gamebox potencialmente
//                          livre, e só serve saber-se antes do dia
//                          (fire-and-forget)
//   'hora_sa'              marcarHoraSa() → só quem trata da marcação da mesa
//                          no Sá, com a hora a partir da qual a pessoa pode lá
//                          estar (fire-and-forget)
//   'mesa_marcada'         marcarMesaHora() → o grupo todo menos quem a marcou:
//                          a mesa ficou marcada a uma hora, e isso é o que
//                          toda a gente estava à espera de saber. É o inverso
//                          do 'hora_sa' — aquele recolhe, este anuncia
//                          (fire-and-forget)
//
// Resolve amigo→email via `amigo_users` (mesma tabela usada nas outras
// políticas de equivalência) e manda o push a cada `push_subscriptions`
// dessa pessoa. Subscriptions que já não existem do lado do browser
// (404/410) são apagadas aqui mesmo. O texto da notificação é sempre
// escolhido AQUI (por `tipo`), nunca vindo livre do cliente — só os nomes/
// valores são interpolados, e a `hora` do 'hora_sa'/'mesa_marcada' só entra
// depois de passar pelo formato HH:MM (é o único campo de texto que o cliente
// escolhe).
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy). Por cima disso confirma-se que o email consta de
// `splitbill.allowed_users`, tal como a `fatura-restaurante` — EXCETO em
// 'pedido_acesso': é precisamente quem ainda NÃO está em allowed_users que
// tem de poder chamar isto (é o próprio pedido de acesso a disparar o
// aviso), por isso aí só se exige um JWT válido.
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
// Mesmo valor do ADMIN_EMAIL em app.js — não é secret (já vai no código
// público do frontend), só se mantém aqui para saber a quem mandar os
// pushes de 'pedido_acesso'.
const ADMIN_EMAIL = "diogo.andre.f.silva@gmail.com";

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

type Sub = { endpoint: string; email: string; p256dh: string; auth_key: string };

async function emailDoToken(auth: string): Promise<string | null> {
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  });
  if (!u.ok) return null;
  const email = ((await u.json()).email ?? "").toLowerCase();
  return email || null;
}

async function estaAutorizado(email: string): Promise<boolean> {
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    { headers: sbHeaders },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function subscriptionsDe(emails: string[]): Promise<Sub[]> {
  if (!emails.length) return [];
  const orEmails = emails.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  const r = await fetch(
    `${SB_URL}/rest/v1/push_subscriptions?email=in.(${orEmails})&select=endpoint,email,p256dh,auth_key`,
    { headers: sbHeaders },
  );
  return r.ok ? await r.json() : [];
}

async function apagarSubsMortas(endpoints: string[]) {
  if (!endpoints.length) return;
  const orMortos = endpoints.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${orMortos})`, {
    method: "DELETE",
    headers: sbHeaders,
  }).catch(() => {});
}

// Manda o mesmo payload a uma lista de subscriptions; devolve {enviados,
// falhados} e apaga as que já não existem do lado do browser (404/410).
async function enviarParaSubs(subs: Sub[], payload: string) {
  let enviados = 0;
  let falhados = 0;
  const mortos: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
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
  await apagarSubsMortas(mortos);
  return { enviados, falhados };
}

type Pessoa = { amigo: string; valor?: number };
type Tipo =
  | "divida"
  | "pagamento_declarado"
  | "lembrete"
  | "pedido_acesso"
  | "gamebox"
  | "hora_sa"
  | "mesa_marcada";

// Nem todos os momentos falam de dinheiro: 'gamebox', 'hora_sa' e
// 'mesa_marcada' vêm sem valor (ou com zero), e um .toFixed() direto num
// undefined rebentava a função toda.
function montarMensagem(tipo: Tipo, p: Pessoa, descricao?: string, quem?: string, hora?: string) {
  const suf = descricao ? ` — ${descricao}` : "";
  const valor = (p.valor ?? 0).toFixed(2);
  if (tipo === "gamebox") {
    return {
      title: "🎟️ Gamebox possivelmente livre",
      body: `${quem || "Alguém"} não vai ao jogo${suf} — pode haver lugar a mais`,
    };
  }
  if (tipo === "hora_sa") {
    return {
      title: "🍽️ Hora para o Sá",
      body: `${quem || "Alguém"} pode estar no Sá a partir das ${hora}${suf}`,
    };
  }
  if (tipo === "mesa_marcada") {
    return {
      title: "🍽️ Mesa marcada no Sá",
      body: `${quem || "Alguém"} marcou a mesa para as ${hora}${suf}`,
    };
  }
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
    const emailChamador = await emailDoToken(auth);
    if (!emailChamador) return json({ error: "não autorizado" }, 403);

    const { pessoas, descricao, quem, tipo, email, hora } = (await req.json()) as {
      pessoas?: Pessoa[];
      descricao?: string;
      quem?: string;
      tipo?: Tipo;
      email?: string;
      hora?: string;
    };

    // 'pedido_acesso': único caso em que NÃO se exige allowed_users — é
    // precisamente quem ainda não tem acesso que dispara isto.
    if (tipo === "pedido_acesso") {
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const payload = JSON.stringify({
        title: "🆕 Novo pedido de acesso",
        body: `${email || emailChamador} pediu acesso ao SplitBill — aprova nas Definições`,
        url: "/SplitBill/",
      });
      return json(await enviarParaSubs(subs, payload));
    }

    if (!(await estaAutorizado(emailChamador))) return json({ error: "não autorizado" }, 403);

    const TIPOS: Tipo[] = ["pagamento_declarado", "lembrete", "gamebox", "hora_sa", "mesa_marcada"];
    const tipoOk: Tipo = tipo && TIPOS.includes(tipo) ? tipo : "divida";
    if (!Array.isArray(pessoas) || pessoas.length === 0) return json({ enviados: 0, falhados: 0 });

    // Único texto do cliente que chega ao corpo de uma notificação — por isso
    // passa pelo formato antes de lá entrar. Sem hora válida não há aviso a dar.
    const horaOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(hora ?? "") ? hora : "";
    if ((tipoOk === "hora_sa" || tipoOk === "mesa_marcada") && !horaOk) {
      return json({ error: "hora inválida" }, 400);
    }

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

    const subs = await subscriptionsDe(emails);

    let enviados = 0;
    let falhados = 0;
    await Promise.all(
      pessoas.map(async (p) => {
        const emailP = emailPorAmigo.get(p.amigo);
        if (!emailP) return;
        const payload = JSON.stringify({
          ...montarMensagem(tipoOk, p, descricao, quem, horaOk),
          url: "/SplitBill/",
        });
        const r = await enviarParaSubs(subs.filter((s) => s.email === emailP), payload);
        enviados += r.enviados;
        falhados += r.falhados;
      }),
    );

    return json({ enviados, falhados });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
