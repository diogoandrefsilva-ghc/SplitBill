// supabase/functions/fatura-restaurante/index.ts
// SplitBill — Lê a fotografia (ou PDF) da fatura/talão do restaurante com o
// Gemini e devolve JSON estruturado (restaurante, data, total, linhas artigo a
// artigo com quantidade e preço) para a app comparar com o que foi marcado
// como consumido no evento.
//
// É a irmã da `fatura-ocr` da FestasBV (mesmo projeto Supabase, outro schema):
// ali o talão é de supermercado e alimenta uma lista de compras; aqui é a conta
// da mesa e alimenta a conferência artigo a artigo do evento. Mantém-se separada
// de propósito — prompt diferente e verificação de acesso contra
// `splitbill.allowed_users`.
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy — é o gateway que valida). Por cima disso confirma-se ainda que o
// email consta de allowed_users (mesma regra de acesso da app).
//
// Secrets necessários (Edge Functions -> Secrets):
//   GEMINI_API_KEY       chave do Google AI Studio (free tier chega)
//   GEMINI_MODEL         (opcional) fixa um modelo concreto; sem ele a função
//                        descobre sozinha o melhor "flash" disponível na chave
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy fatura-restaurante

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// Limite próprio para a chamada ao Gemini. Abaixo dos ~60s a que o Safari/iOS
// mata o pedido, para conseguirmos devolver um erro claro em vez de "Load failed".
const TIMEOUT_MS = 50_000;

/* ── Escolha do modelo ──
   Os nomes dos modelos Gemini mudam com o tempo. Em vez de fixar um nome,
   pergunta-se à API que modelos a chave tem (ListModels) e ordenam-se os
   "flash" do melhor para o pior. Devolve-se a LISTA (não só o topo) para se
   poder cair para o modelo seguinte quando o preferido falha (404 se o modelo
   foi reformado, 503 se está sobrecarregado). O secret GEMINI_MODEL (opcional)
   é apenas uma PREFERÊNCIA: entra em primeiro lugar mas, se estiver morto, a
   descoberta apanha o pedido a seguir. Cache em memória enquanto a instância
   viver. */
let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") &&
    !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  ))];
  const score = (n: string): number => {
    if (n === "gemini-flash-latest") return 100; // apontador sempre atualizado
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0; // versão exata; genéricos ao fundo
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
// `signal` liga esta descoberta ao MESMO limite de tempo da chamada ao Gemini
// (ver TIMEOUT_MS mais abaixo) — sem isto, um ListModels preso ficava fora do
// alcance do timeout e a função inteira pendurava-se sem nunca responder.
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 3; i++) {
      const r = await fetch(
        `${GAPI}/models?pageSize=200${page ? `&pageToken=${page}` : ""}&key=${GEMINI_KEY}`,
        { signal },
      );
      if (!r.ok) break;
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        if ((m.supportedGenerationMethods ?? []).includes("generateContent")) {
          names.push(String(m.name).replace(/^models\//, ""));
        }
      });
      page = d.nextPageToken ?? "";
      if (!page) break;
    }
    const ranked = rankFlash(names);
    if (ranked.length) _models = ranked;
  } catch (_) { /* fica o fallback (inclui abort do timeout) */ }
  return _models ?? [];
}
// Aliases estáveis do Gemini, por ordem de preferência. São apontadores que a
// Google mantém a apontar para o modelo flash atual — ao contrário dos nomes
// datados (ex.: gemini-2.0-flash-001), que são reformados e passam a dar 404.
const ESTAVEIS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
async function candidatosModelo(signal: AbortSignal): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const descobertos = await descobrirFlash(signal);
  const vistos = new Set<string>();
  const lista = [...(pinned ? [pinned] : []), ...ESTAVEIS, ...descobertos]
    .filter((m) => (vistos.has(m) ? false : vistos.add(m)));
  return lista.length ? lista : ["gemini-flash-latest"];
}

// A app corre no GitHub Pages (origem diferente) → CORS obrigatório
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Menu do evento (opcional) ──
   A app manda os artigos que já existem no menu (nome + preço). Serve para o
   modelo devolver EXATAMENTE o nome que a app já usa em vez de uma grafia nova
   ("Imperial"/"imperiais"/"Cerveja Imperial") — é isso que faz a conferência
   artigo a artigo bater certo. O preço vai junto só como contexto: o que conta
   é sempre o que está impresso na fatura. */
type Art = { nome: string; preco: number | null };
function lerMenu(raw: unknown): Art[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a.nome === "string" && a.nome.trim())
    .slice(0, 200)
    .map((a) => ({
      nome: String(a.nome).replace(/\s+/g, " ").trim().slice(0, 60),
      preco: typeof a.preco === "number" && isFinite(a.preco) ? a.preco : null,
    }));
}

const promptFatura = (menu: Art[]) => `Isto é a conta (fatura ou talão) de um
restaurante/café em Portugal — fotografia ou PDF (pode ter várias páginas ou
várias fotos da mesma conta; considera todas).

Extrai APENAS um objeto JSON com esta forma exata:
{"restaurante": string|null, "data": "YYYY-MM-DD"|null, "total": number|null,
 "linhas": [{"artigo": string, "qtd": number|null, "precoUnit": number|null, "precoTotal": number|null}]}

Regras:
- "linhas": só o que foi consumido (comida e bebida). Uma entrada por linha da
  conta, pela ordem em que aparecem.
- IGNORA linhas que não são consumo: subtotais, total, IVA/taxas, taxa de
  serviço, gorjeta, arredondamentos, desconto isolado, troco, número de mesa,
  número de pessoas, dados fiscais e rodapés.
- Couvert, pão, azeitonas, manteiga, entradas, cafés e digestivos SÃO consumo —
  entram como artigos normais.
- "qtd": quantas unidades essa linha traz, em número (2, 1, 3). Se a linha não
  indicar quantidade, usa 1.
- "precoUnit": preço de UMA unidade, em euros. "precoTotal": o valor cobrado
  nessa linha (qtd × preço unitário), em euros, JÁ COM o desconto dessa linha
  aplicado se existir. Se só um dos dois estiver impresso, calcula o outro a
  partir da quantidade. Usa ponto decimal.
- "artigo": nome legível em português. Expande abreviaturas óbvias
  ("Cv" -> "Couvert", "Imp" -> "Imperial", "Bit. Vaca" -> "Bitoque de vaca")
  mas não inventes o que não se lê.
- "total": o total FINAL a pagar impresso na conta (com taxas/serviço, se
  houver). null se não se ler.
- "restaurante": nome do estabelecimento, sem morada nem NIF.${menu.length ? `
- Se o artigo for O MESMO produto de um destes já usados neste grupo, devolve
  EXATAMENTE esse nome (copia tal e qual) em vez de uma grafia nova. Se for
  outro produto, escreve o nome normalmente — não forces a correspondência,
  e nunca uses o preço da lista: o preço vem sempre da fatura.
  Artigos já em uso:
${menu.map((a) => `  · ${a.nome}${a.preco != null ? ` (€${a.preco.toFixed(2)})` : ""}`).join("\n")}` : ""}
- Se algo não se ler com confiança, usa null nesse campo em vez de adivinhar.
Responde só com o JSON.`;

async function emailAutorizado(auth: string, signal: AbortSignal): Promise<boolean> {
  console.log("FATURA-RESTAURANTE auth header presente:", !!auth, "tamanho:", auth.length);
  // 1) quem é o utilizador deste token?
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
    signal,
  });
  console.log("FATURA-RESTAURANTE /user status:", u.status, "ok:", u.ok);
  if (!u.ok) {
    console.log("FATURA-RESTAURANTE /user erro:", (await u.text().catch(() => "")).slice(0, 300));
    return false;
  }
  const uj = await u.json();
  const email = (uj.email ?? "").toLowerCase();
  console.log("FATURA-RESTAURANTE email presente:", !!email, "sub presente:", !!uj.id);
  if (!email) return false;
  // 2) consta de splitbill.allowed_users?
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    {
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Accept-Profile": "splitbill",
      },
      signal,
    },
  );
  console.log("FATURA-RESTAURANTE allowed_users status:", r.status, "ok:", r.ok);
  if (!r.ok) return false;
  const rows = await r.json();
  const permitido = Array.isArray(rows) && rows.length > 0;
  console.log("FATURA-RESTAURANTE permitido:", permitido);
  return permitido;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  // O Safari/iOS corta pedidos que passem dos ~60s ("Load failed", sem
  // detalhe). Impomos um limite próprio mais curto para conseguir devolver
  // um erro legível ANTES de o browser rebentar às cegas. Criado JÁ AQUI, à
  // entrada do pedido, e usado em TODOS os fetch feitos a seguir (auth,
  // ListModels, Gemini) — um único fetch sem este signal já chegou a deixar
  // a função pendurada indefinidamente, sem nunca responder ao browser.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    console.log("FATURA-RESTAURANTE start");
    const auth = req.headers.get("Authorization") ?? "";
    const ok = await emailAutorizado(auth, ctrl.signal);
    console.log("FATURA-RESTAURANTE autorizado:", ok);
    if (!ok) {
      return json({ error: "não autorizado" }, 403);
    }

    const { image, mime, menu } = await req.json();
    if (!image || typeof image !== "string" || image.length > 6_000_000) {
      return json({ error: "imagem em falta ou demasiado grande" }, 400);
    }
    const parts: unknown[] = [
      { inline_data: { mime_type: mime || "image/jpeg", data: image } },
      { text: promptFatura(lerMenu(menu)) },
    ];

    const chamarGemini = (model: string, desligarThinking = true) => {
      const generationConfig: Record<string, unknown> = {
        response_mime_type: "application/json",
        temperature: 0,
      };
      // Os modelos 2.5 "pensam" por defeito e isso pode custar dezenas de
      // segundos — o suficiente para estoirar o limite do Safari. Com
      // thinkingBudget:0 desligamos o thinking (resposta muito mais rápida).
      // Se o modelo não suportar o campo devolve 400 → repetimos sem ele.
      if (desligarThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      });
    };

    // 429/500/503 = sobrecarga temporária do lado do Google ("high demand").
    const transitorio = (s: number) => s === 429 || s === 500 || s === 503;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    // Percorre os modelos flash disponíveis. Para cada um tolera uma repetição
    // em erros transitórios (com pequeno backoff); se persistir, cai para o
    // modelo seguinte.
    const candidatos = await candidatosModelo(ctrl.signal);
    // A descoberta de modelos engole o AbortError (fica só com o fallback) —
    // se o timeout já disparou durante ela, trata-se igual a estoirar o
    // timeout na chamada ao Gemini, em vez de um 502 genérico sem explicação.
    if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
    console.log("FATURA-RESTAURANTE candidatos:", candidatos.join(", "));
    let model = candidatos[0] ?? "gemini-flash-latest";
    let g: Response | null = null;

    for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
      model = candidatos[ci];
      for (let tent = 0; tent < 2 && !ctrl.signal.aborted; tent++) {
        g = await chamarGemini(model);
        console.log("FATURA-RESTAURANTE tentativa:", model, "->", g.status);
        // 400 = "invalid argument". O campo mais frágil é o thinkingConfig
        // (vários modelos recusam thinkingBudget:0, às vezes com a mensagem
        // genérica sem dizer qual). Em QUALQUER 400 repete-se uma vez sem esse
        // campo — se o problema era esse, passa; se não, cai no erro normal.
        if (g.status === 400) {
          console.log("FATURA-RESTAURANTE 400:", (await g.clone().text()).slice(0, 300));
          g = await chamarGemini(model, false);
          console.log("FATURA-RESTAURANTE 400 retry s/thinking:", model, "->", g.status);
        }
        // Nome saiu do catálogo (404) → força redescoberta e salta de modelo.
        if (g.status === 404) { _models = null; break; }
        // Sobrecarga temporária → espera e repete o MESMO modelo.
        if (transitorio(g.status)) { await sleep(700 * (tent + 1)); continue; }
        break; // resposta definitiva (ok ou erro não recuperável)
      }
      if (g && g.ok) break;                                  // sucesso
      if (g && !transitorio(g.status) && g.status !== 404) break; // erro real
      // caso contrário (503 persistente ou 404) → tenta o próximo candidato
    }

    if (!g || !g.ok) {
      const status = g?.status ?? 502;
      const detail = g ? await g.text() : "";
      console.error("gemini", model, status, detail.slice(0, 500));
      if (transitorio(status)) {
        return json({
          error: "o serviço de leitura está com muita procura agora — espera um minuto e tenta outra vez",
        }, 503);
      }
      let msg = "";
      try {
        const j = JSON.parse(detail);
        msg = j?.error?.message ?? "";
        const fv = (j?.error?.details ?? [])
          .flatMap((x: any) => x?.fieldViolations ?? [])
          .map((v: any) => v?.field)
          .filter(Boolean);
        if (fv.length) msg += ` [${fv.join(", ")}]`;
      } catch (_) { /**/ }
      return json({ error: `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}` }, 502);
    }
    const gd = await g.json();
    const text = gd?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return json({ error: "resposta ilegível do modelo" }, 502);
    }
    return json(parsed);
  } catch (e) {
    const err = e as Error;
    // Estoirou o nosso timeout antes de o modelo responder.
    if (err.name === "AbortError") {
      return json({
        error: "o modelo demorou demasiado a ler a fatura — tenta uma foto mais nítida ou um PDF com menos páginas",
      }, 504);
    }
    return json({ error: err.message }, 500);
  } finally {
    // Limpo aqui (não logo a seguir ao Gemini responder) para o limite
    // continuar a proteger a leitura do corpo da resposta (g.text()/g.json())
    // — um corpo a chegar aos soluços também não pode ficar por prender.
    clearTimeout(timer);
  }
});
