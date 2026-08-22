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
- **Convocados e menu do evento:** persistem nas colunas `eventos.amigos` / `eventos.menu` (jsonb, `db/convocados-menu.sql`). `ev.amigos` é a lista de **candidatos** (quem foi convocado); quem **consumiu** está em `ordem_amigos`/`oferta_para` — não confundir (`presentesNoEvento()` usa o segundo). Ao carregar da BD faz-se a união das duas (`convocadosDoEvento()`), para os eventos anteriores à migração não ficarem vazios. Sem a migração, `AMIGOS_COL`/`MENU_COL=false` e ficam só no localStorage.
- Mudança **só visual** → `style.css`. Mudança de **lógica/dados** → `app.js`. Para localizar um botão/campo: procura o `id` no `index.html` e salta para o handler no `app.js`.
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro.**

## Calendário do Sporting (ecrã inicial › Calendário › "Jogos em Alvalade")
Botão só do admin que vai buscar o calendário oficial da época e **sugere**
(1) eventos a criar para os jogos em Alvalade que ainda não têm um e (2) datas
que mudaram. **Nada é gravado sem confirmação linha a linha** — a leitura é por
IA e um evento com a data errada estraga o dia de jogo todo.
- Quem procura é a Edge Function **`calendario-sporting`**, **partilhada com a
  app Goals**: o ficheiro vive no repo do Goals (`Goals/calendario-sporting.ts`,
  deploy com `supabase functions deploy calendario-sporting`). Devolve SEMPRE a
  época inteira (todas as competições, casa/fora/neutro) porque o Goals quer
  tudo; aqui filtra-se com `_calEmAlvalade` (jogos de casa + campo neutro que
  calhe ser em Alvalade). **Se mexeres no contrato, mexe nos dois lados.**
- Usa grounding com pesquisa Google — sem isso o modelo inventava datas futuras
  de memória. Só o admin pode chamar (verificação no servidor, não na UI).
- Secção `CALENDÁRIO DO SPORTING` no `app.js`. O que interessa lá é
  `_calPontuarEv`: mesmo dia decide sozinho (o evento do dia de jogo É o jogo,
  chame-se ele o que se chamar); fora disso a descrição tem de nomear o
  adversário (`_calSimDesc`, tolerante a "FC Porto"/"Porto") e a data tem de
  andar a ≤21 dias. Eventos **já fechados** contam para não duplicar mas nunca
  são tocados — a data deles é história.
- Os eventos criados nascem sem tesoureiro; convocados e menu vêm dos de sempre,
  calculados **uma vez** antes do ciclo (ver comentário em `calAplicar`).

## Jogos futuros no ecrã: o calendário da época não pode encher a lista
Com o calendário criado de uma vez, "eventos em aberto" passou a incluir meia
época de jogos por acontecer. Por isso:
- **Ecrã inicial** (`renderInicio`, no `index.html`): "Em aberto" só leva os de
  hoje/passado (é onde há conta por fechar); os futuros vão para "Próximos
  jogos", com `FUTUROS_A_MOSTRAR` (3) à vista e o resto atrás de "mais N jogos".
- **Painel do histórico** (`renderHistoricoDropdown`): ordenado por **data** e já
  não por ordem de criação, com os "Por jogar" num bloco à cabeça (2 à vista,
  resto colapsado) e os "Já jogados" a seguir.
- `eventoPorDefeito()` substituiu o "último do histórico" no arranque e nos
  fallbacks: o último a ser CRIADO passou a ser o último jogo da época. Agora
  abre-se o evento mais próximo de hoje, com preferência pelo passado.
- `amigosPorDefeito()` olha para os últimos 10 eventos **com consumo**, não para
  as últimas 10 linhas — senão os jogos futuros vazios zeravam a contagem.

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
