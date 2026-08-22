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
  Custom confirm modal · **Pagador & Contas (dívidas)** · Page switching · FAB · **Core: cálculo de saldos** (dívidas + pagamentos) · Render · Payment form · Edit Ordem inline · **Importar Fatura** (foto/PDF → Gemini → conferência artigo a artigo) · **Jogo aberto & presenças** (abrir o jogo, vou/não vou) · Configs · **Supabase** (+ Sessão/refresh do token, Permissões, Agregação global, IDs únicos, Equivalências amigo↔conta)
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
- **Nome do evento: `Sporting vs Adversário`** (`_calDescricao`), o mesmo formato
  dos criados à mão desde sempre. Já esteve com traço e o resultado foi a lista
  com dois formatos ao mesmo tempo — se mexeres no separador, mexe nos eventos
  que já lá estão.
- **Quando falha:** o erro fica no ecrã (`_calErro`), com o passo e a hora, em
  vez de uma mensagem que se some. O detalhe do lado do servidor (modelo, se
  houve pesquisa Google, erro do Gemini) vai para `goals.sync_log` — a Edge
  Function é que o escreve, com a service role, e o campo `app` diz que veio
  daqui. Esta app não escreve lá directamente (não tem acesso ao schema
  `goals`); só manda `app:'splitbill'` no pedido.

## Jogos futuros no ecrã: o calendário da época não pode encher a lista
Com o calendário criado de uma vez, "eventos em aberto" passou a incluir meia
época de jogos por acontecer. Por isso:
- **Ecrã inicial** (`renderInicio`, no `index.html`): "Em aberto" só leva os
  jogos **abertos** (ver secção seguinte). Os que estão por abrir vivem em
  **"Próximos Jogos em Alvalade"** (`proximosAlvalade()`), no **fim do ecrã, a
  seguir ao Consumo** — é agenda, não é trabalho por fazer, e não deve empurrar
  para baixo o que precisa de atenção hoje. `FUTUROS_A_MOSTRAR` (2) à vista, o
  resto atrás de "mais N jogos". A secção aparece **sempre**, mesmo sem jogos: é
  lá que o admin tem o botão de sincronizar (e só o admin o vê).
- **Painel do histórico** (`renderHistoricoDropdown` + `eventosDoHistorico()`):
  ordenado por **data** e já não por ordem de criação, e **só leva o que já
  aconteceu** — jogos abertos ou fechados. Os que estão por abrir não entram:
  "histórico" com jogos futuros não quer dizer nada, e vivem no ecrã inicial.
  Como esta era a única porta para a página de um jogo por abrir, a folha do
  jogo tem o botão **Preparar** (`_podeGerirJogo`, só admin/substituto): leva à
  página do evento **sem o abrir**, para acertar menu, convocados e tesoureiro
  antes do dia.
- `eventoPorDefeito()` substituiu o "último do histórico" no arranque e nos
  fallbacks: o último a ser CRIADO passou a ser o último jogo da época. Agora
  abre-se o evento mais próximo de hoje, com preferência pelo passado.
- `amigosPorDefeito()` devolve a lista fixa de `splitbill.config` quando existe
  (ver abaixo); sem ela cai na heurística antiga, que olha para os últimos 10
  eventos **com consumo** e não para as últimas 10 linhas — senão os jogos
  futuros vazios zeravam a contagem.

## O jogo abre-se à mão + vou/não vou (`db/jogo-aberto.sql`)
A data deixou de ser o que decide se um jogo está "em aberto": com a época
inteira criada de uma vez, bastava a data chegar para o jogo aparecer como conta
por fechar, tivesse lá ido alguém ou não. Agora o jogo nasce em **agenda** e só
passa a aberto quando **o admin (ou o substituto do evento)** o abre.
- Vive na coluna `eventos.aberto`. `NULL` = evento anterior à migração, e aí
  `jogoAberto()` cai no critério antigo (a data). Sem a migração, `ABERTO_COL`
  fica false, o botão "Abrir jogo" esconde-se e tudo se comporta como antes.
  O retroactivo da migração abre tudo o que já foi jogado ou é de hoje/passado —
  é o que mantém o jogo a decorrer em "Em aberto".
- Secção **`JOGO ABERTO & PRESENÇAS`** no `app.js`: `jogoAberto()`,
  `jogosPorAbrir()` (ordenados por data), `podeAbrirJogo()` — **só o primeiro**
  da lista se pode abrir, abrir o de daqui a dois meses seria sempre engano —,
  `abrirJogo()` e a folha que se abre ao tocar no cartão (`abrirFolhaJogo`).
  A folha tem até três botões: Fechar · **Preparar** (admin/substituto, abre a
  página do evento sem abrir o jogo) · **Abrir jogo** (só no primeiro). O
  "Preparar" usa o `extraText` do `mostrarModal`.
- Um evento criado à mão nasce aberto se a data for de hoje/passado; marcado para
  a frente nasce em agenda. Os do calendário nascem sempre em agenda.
- **Vou / Não vou:** na mesma folha, qualquer convocado marca se vai — e isso
  mexe na lista de convocados do evento (`ev.amigos`), que é a mesma que depois
  aparece na grelha de amigos. Quem pode editar o evento grava pelo caminho
  normal (PATCH); os outros vão pela função `marcar_presenca` do servidor
  (`sbMarcarPresenca`), SECURITY DEFINER, que **só** acrescenta ou tira dessa
  lista os nomes da conta autenticada — dar UPDATE em `eventos` a um convocado
  deixava-o mexer na fatura, no pagador e no substituto.
- O cartão do jogo por abrir tem cor própria (`.sbi-fut`, dourado/creme). O verde
  (`.sbi-open`) é do jogo em aberto: são coisas diferentes e não se podem
  confundir.

## Convocados por defeito (Definições › Convocados por defeito, só admin)
Quem entra por omissão num evento novo. Antes era **adivinhado** (quem tivesse
aparecido em ≥3 dos últimos 10 eventos com consumo): funcionava, mas mudava
sozinho conforme quem faltasse e ninguém percebia porquê.
- Vive em `splitbill.config`, chave `convocados_default`
  (`{"amigos":[...]}`, migração `db/config-convocados.sql`). Tabela genérica de
  chave/valor de propósito — a próxima definição global entra lá sem migração.
- `CONVOCADOS_DEFAULT` guarda a lista; `null` = migração por correr, e aí a app
  comporta-se exactamente como antes (`amigosPorDefeito()` cai na heurística).
- O painel (`abrirConvocados`) relê do servidor **antes** de desenhar: gravar
  por cima de memória velha apagaria o que tivesse sido mudado noutro
  dispositivo. A edição vive em `_convSel` até se carregar em Guardar.

## Duas armadilhas do CSS global (já mordidas)
- **`input, select { appearance: none }`** (para os campos de texto) apaga o
  desenho nativo das **checkboxes**: elas mudam de estado mas ficam visualmente
  iguais — carrega-se e "não acontece nada". Qualquer checkbox nova precisa de
  `appearance: checkbox` e de desfazer padding/borda/fundo/cantos herdados (ver
  `.calsug-row input`, `.conv-row input`).
- **`hidden` não colapsa nada** dentro do ecrã inicial: `.sbi-list{display:flex}`
  é regra de autor e ganha ao `[hidden]` do browser — o bloco "mais N jogos"
  aparecia todo na mesma. Resolve-se com `.sbi-list[hidden]{display:none}` (já lá
  está); qualquer lista nova com `display` próprio precisa do mesmo par.
- **`button:hover { background:#0B6340 }`** ganha em especificidade a qualquer
  classe de botão que definas, e no telemóvel o `:hover` fica colado depois do
  toque — o botão fica verde escuro com o texto ilegível. Neutraliza sempre com
  uma regra `.a-tua-classe, .a-tua-classe:hover { … }`. No ecrã inicial há um
  bloco só para isto (`.sbi-tap:hover` e uma linha por cartão, logo a seguir):
  **cartão novo = linha nova lá**, e a ordem conta — `.sbi-tap:hover` e
  `.sbi-open:hover` têm a mesma especificidade e ganha a última.

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
