# SplitBill — guia para o assistente

App pessoal de divisão de contas ("dia de jogo").
**Sem build, sem npm, sem dependências.** É servida estática no GitHub Pages e usa **Supabase (REST)** como backend. PWA (funciona offline / instalável).

## Ficheiros — edita só o que for preciso
- `index.html` — só markup + referências (`<link>`/`<script>`) e o ecrã de splash. ~850 linhas. É aqui que vês os **ids** dos elementos.
- `app.js` — **toda a lógica** (~3700 linhas). É aqui que está quase tudo.
- `style.css` — **todo o CSS** (~1400 linhas). Cores, tamanhos, espaçamento, layout.
- `sw.js` — service worker (cache offline).
- Não mexer: `manifest.json`.

## Como NÃO gastar tokens à toa (importante)
- **Não leias o `app.js` inteiro.** Está dividido em secções com comentários `/* ── título ── */`. Para achar algo, faz `grep` pelo título e lê só esse troço. Secções:
  Custom confirm modal · **Pagador & Contas (dívidas)** · Page switching · FAB · **Core: cálculo de saldos** (dívidas + pagamentos) · Render · Payment form · Edit Ordem inline · Configs · **Supabase** (+ Sessão/refresh do token, Permissões, Agregação global, IDs únicos, Equivalências amigo↔conta)
- Mudança **só visual** → `style.css`. Mudança de **lógica/dados** → `app.js`. Para localizar um botão/campo: procura o `id` no `index.html` e salta para o handler no `app.js`.
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro.**

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há `onclick="…"` no HTML, logo as funções têm de ser **globais**. Não converter para módulo.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`, **sobe `CACHE_VERSION` no `sw.js`** (ex.: `v5` → `v6`). Estes três já são *network-first* (atualizam sozinhos), mas o bump garante que ninguém fica com versão velha.
- **Supabase:** schema `splitbill`. A chave no topo do `app.js` é a **`anon` (pública, por design)**, protegida por RLS + login Google. **Não é bug nem risco — não a "corrijas" nem a escondas.** Acesso controlado por funções `is_allowed()`/`is_admin()`/`pode_editar_*()` no servidor.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica (caminho do site: `/SplitBill/`).

## Fluxo de branches (importante)
Quando o utilizador pede **novas alterações** depois de já existir um branch de trabalho:
- **Verifica primeiro se o branch anterior já foi *merged* para `main`** (ex.: `git fetch origin main` e ver se os commits do branch já lá estão / `git branch --merged origin/main`).
- **Se já foi merged →** cria um **branch novo** (o utilizador não consegue voltar a fazer merge de um PR já merged). Incrementa o sufixo (ex.: `…-v3` → `…-v4`).
- **Se ainda NÃO foi merged →** continua a trabalhar **no mesmo branch**.
