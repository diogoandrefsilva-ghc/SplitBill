# SplitBill — guia para o assistente

App pessoal de divisão de contas ("dia de jogo").
**Sem build, sem npm, sem dependências.** É servida estática no GitHub Pages e usa **Supabase (REST)** como backend. PWA (funciona offline / instalável).

## Ficheiros — edita só o que for preciso
- `index.html` — só markup + referências (`<link>`/`<script>`) e o ecrã de splash. ~850 linhas. É aqui que vês os **ids** dos elementos.
- `app.js` — **toda a lógica** (~3700 linhas). É aqui que está quase tudo.
- `style.css` — **todo o CSS** (~1400 linhas). Cores, tamanhos, espaçamento, layout.
- `sw.js` — service worker (cache offline).
- `db/` — migrações SQL para correr à mão no SQL Editor do Supabase. São idempotentes e a app é tolerante à falta delas (degrada, não rebenta).
- Não mexer: `manifest.json`.

## Como NÃO gastar tokens à toa (importante)
- **Não leias o `app.js` inteiro.** Está dividido em secções com comentários `/* ── título ── */`. Para achar algo, faz `grep` pelo título e lê só esse troço. Secções:
  Custom confirm modal · **Pagador & Contas (dívidas)** · Page switching · FAB · **Core: cálculo de saldos** (dívidas + pagamentos) · Render · Payment form · Edit Ordem inline · **Importar Fatura** (foto/PDF → Gemini → conferência artigo a artigo) · Configs · **Supabase** (+ Sessão/refresh do token, Permissões, Agregação global, IDs únicos, Equivalências amigo↔conta)
- `fatura-restaurante.ts` — Edge Function (Deno) que lê a fatura com o Gemini. **Não corre no site**: vive no Supabase, faz-se deploy à parte (`supabase functions deploy fatura-restaurante`). É irmã da `fatura-ocr` da FestasBV — mesmo projeto Supabase, schema e prompt diferentes.
- **Fatura guardada:** o detalhe lido fica em `estado.fatura` e persiste na coluna `eventos.fatura` (jsonb, `db/fatura-detalhe.sql`). A correspondência linha-da-fatura ↔ artigo do menu **não** se guarda — é recalculada a cada render (`faturaConferir()`), de propósito: se o menu do evento mudar, a conferência acompanha. Sem a migração, `FATURA_COL=false` e a fatura fica só no localStorage.
- Mudança **só visual** → `style.css`. Mudança de **lógica/dados** → `app.js`. Para localizar um botão/campo: procura o `id` no `index.html` e salta para o handler no `app.js`.
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro.**

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há `onclick="…"` no HTML, logo as funções têm de ser **globais**. Não converter para módulo.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`, **sobe `CACHE_VERSION` no `sw.js`** (ex.: `v5` → `v6`). Estes três já são *network-first* (atualizam sozinhos), mas o bump garante que ninguém fica com versão velha.
- **Supabase:** schema `splitbill`. A chave no topo do `app.js` é a **`anon` (pública, por design)**, protegida por RLS + login Google. **Não é bug nem risco — não a "corrijas" nem a escondas.** Acesso controlado por funções `is_allowed()`/`is_admin()`/`pode_editar_*()` no servidor.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica (caminho do site: `/SplitBill/`).

## Fluxo de branches (importante)
**Antes de QUALQUER pedido que vá gerar commits** (não só no início da sessão — sempre, a cada novo pedido), corre primeiro esta verificação, antes de editar ficheiros:
- `git fetch origin main` e vê se os commits do branch de trabalho atual já estão na main (`git branch --merged origin/main` / `git log origin/main..HEAD`).
- **Se já foi merged →** cria um **branch novo** com sufixo incrementado (ex.: `…-v2` → `…-v3`) a partir da `origin/main`. O utilizador não consegue voltar a fazer merge de um PR já merged.
- **Se ainda NÃO foi merged →** continua a trabalhar **no mesmo branch**.

**Isto aplica-se mesmo quando o branch vem fixado pelo harness/tarefa.** Se o branch indicado já estiver merged, cria à mesma o branch incrementado e avisa o utilizador — a regra "não fazer push para outro branch" não impede criar o branch sancionado pelo fluxo (incrementado). Em caso de dúvida, pergunta.
