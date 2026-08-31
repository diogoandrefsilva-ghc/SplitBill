# SplitBill — guia para o assistente

App pessoal de divisão de contas ("dia de jogo").
**Sem build, sem npm, sem dependências.** É servida estática no GitHub Pages e usa **Supabase (REST)** como backend. PWA (funciona offline / instalável).

## Ficheiros — edita só o que for preciso
- `index.html` — só markup + referências (`<link>`/`<script>`) e o ecrã de splash. ~850 linhas. É aqui que vês os **ids** dos elementos.
- `app.js` — **toda a lógica** (~3700 linhas). É aqui que está quase tudo.
- `style.css` — **todo o CSS** (~1400 linhas). Cores, tamanhos, espaçamento, layout.
- `sw.js` — service worker (cache offline).
- `db/` — migrações SQL para correr à mão no SQL Editor do Supabase. São idempotentes e a app é tolerante à falta delas (degrada, não rebenta). A do calendário (`jogo-id.sql`) tem uma irmã no outro repo: `Goals/db/jogos-leitura-partilhada.sql`.
- `logos-competicoes/` — os 5 PNG dos símbolos das competições, cópia dos do
  Goals. Estão cá (e não a apontar para o outro site) para o cartão dos
  Próximos Jogos funcionar offline, como o resto da PWA.
- Não mexer: `manifest.json`.

## Como NÃO gastar tokens à toa (importante)
- **Não leias o `app.js` inteiro.** Está dividido em secções com comentários `/* ── título ── */`. Para achar algo, faz `grep` pelo título e lê só esse troço. Secções:
  Custom confirm modal · **Pagador & Contas (dívidas)** · Page switching · FAB · **Core: cálculo de saldos** (dívidas + pagamentos) · Render · Payment form · Edit Ordem inline · **Importar Fatura** (foto/PDF → Gemini → conferência artigo a artigo) · **Calendário do Sporting** (ler `goals.jogos`, guardar o mínimo cá) · **Jogo aberto & presenças** (abrir o jogo, vou/não vou, hora do Sá) · Configs · **Supabase** (+ Sessão/refresh do token, Permissões, Agregação global, IDs únicos, Equivalências amigo↔conta)
- `fatura-restaurante.ts` — Edge Function (Deno) que lê a fatura com o Gemini. **Não corre no site**: vive no Supabase, faz-se deploy à parte (`supabase functions deploy fatura-restaurante`). É irmã da `fatura-ocr` da FestasBV — mesmo projeto Supabase, schema e prompt diferentes.
- `push-notificar.ts` — a outra Edge Function, a das notificações Web Push. Também **não corre no site** (`supabase functions deploy push-notificar`): se mexeres nos `tipo` daqui, o texto novo só aparece depois desse deploy. O corpo da notificação é escolhido **lá**, nunca vem livre do cliente — só nomes, valores e a hora do Sá (validada `HH:MM` dos dois lados) são interpolados.
- **Fatura guardada:** o detalhe lido fica em `estado.fatura` e persiste na coluna `eventos.fatura` (jsonb, `db/fatura-detalhe.sql`). A correspondência linha-da-fatura ↔ artigo do menu **não** se guarda — é recalculada a cada render (`faturaConferir()`), de propósito: se o menu do evento mudar, a conferência acompanha. Sem a migração, `FATURA_COL=false` e a fatura fica só no localStorage.
- **Convocados e menu do evento:** persistem nas colunas `eventos.amigos` / `eventos.menu` (jsonb, `db/convocados-menu.sql`). `ev.amigos` é a lista de **candidatos** (quem foi convocado); quem **consumiu** está em `ordem_amigos`/`oferta_para` — não confundir (`presentesNoEvento()` usa o segundo). Ao carregar da BD faz-se a união das duas (`convocadosDoEvento()`), para os eventos anteriores à migração não ficarem vazios. Sem a migração, `AMIGOS_COL`/`MENU_COL=false` e ficam só no localStorage.
- Excepção conhecida: o **ecrã inicial** (hub) tem o CSS todo num
  `<style id="sbi-css">` dentro do `index.html`, junto do `renderInicio` que o
  desenha — é o único bloco que não vive no `style.css`.
- Mudança **só visual** → `style.css`. Mudança de **lógica/dados** → `app.js`. Para localizar um botão/campo: procura o `id` no `index.html` e salta para o handler no `app.js`.
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro.**

## Calendário: quem manda é o Goals; aqui só se lê (`goals.jogos`)
Esta app **já não pergunta o calendário à IA**. Quem chama a Edge Function
`calendario-sporting`, quem confere sugestão a sugestão e quem grava é a app
**Goals** — o resultado fica em `goals.jogos`, no MESMO projeto Supabase, e é
de lá que esta app lê. **Não há botão de sincronizar no SplitBill.**
- **Porquê:** durante algum tempo as duas apps perguntaram o mesmo à mesma
  função e guardaram a resposta cada uma para seu lado. Bastava sincronizar só
  uma para as listas ficarem diferentes — a mesma pergunta, duas respostas, e
  nenhuma obviamente a certa. Um calendário, um dono.
- **O que fica deste lado:** um **evento** por jogo em Alvalade
  (`splitbill.eventos`), porque é nele que vivem as coisas que só existem aqui —
  convocados, menu, tesoureiro, quem vai ao jogo, quem vai ao Sá, ordens e
  fatura. Da ficha do jogo (hora, competição, jornada, adversário, estádio) não
  se guarda cópia: lê-se a cada render.
- Secção **`CALENDÁRIO DO SPORTING`** no `app.js`, em três blocos:
  helpers de nome/data · **LER `goals.jogos`** · **GUARDAR O MÍNIMO CÁ**.

### Ler (`carregarCalendarioGoals`, `fichaJogoEvento`)
- `GET /rest/v1/jogos` com `Accept-Profile: goals` (é o header que aponta para o
  outro schema, nunca o URL), `por_definir=is.false` e `data>=hoje-45d`. **Só
  SELECT** — escrever em `goals.jogos` é do admin do Goals.
- **Migração:** `Goals/db/jogos-leitura-partilhada.sql` (o schema `goals` tem a
  fonte de verdade nesse repo) — policy de SELECT para qualquer conta
  autenticada. Sem ela só quem está em `goals.allowed_users` veria a ficha.
  `goals.jogos` não tem colunas de dinheiro e já era legível pelo role `anon`
  (acesso de convidado do Goals), por isso não abre nada de novo.
- **TOLERANTE:** sem a migração, sem rede ou com o calendário por sincronizar,
  `GOALS_JOGOS` fica vazio e `fichaJogoEvento()` tira o adversário e a
  competição da **descrição do evento** ("Sporting vs Adversário [(Competição)]",
  `_calDescricao`). Perde-se a hora e o escudo, mais nada.
- **Escudos dos adversários:** o mesmo `logos.json` do repo público AppDataJSON
  que o Goals já lê. Não passa pelo Supabase e não é dado de utilizador.
- As duas leituras arrancam **sem `await`**: não podem atrasar a app, e
  re-renderizam o ecrã inicial quando chegam.

### Guardar o mínimo (`sincronizarJogosDoGoals`, `db/jogo-id.sql`)
- **`eventos.jogo_id`** é a ligação evento ↔ jogo. Exacta, e por isso sobrevive
  a remarcações e a mudanças de nome dos dois lados. O emparelhamento por
  nome+data (`_calPontuarEv`: mesmo dia decide sozinho; fora disso a descrição
  tem de nomear o adversário e a data andar a ≤21 dias) **só** serve os eventos
  SEM ligação — os criados à mão e os anteriores à migração.
- Corre **sozinha** na carga e no sincronizar, **só para o admin** (é quem tem
  INSERT/UPDATE em `eventos`). **Sem confirmação linha a linha**, ao contrário
  da sincronização por IA que substituiu — e de propósito: o que aqui chega já
  foi confirmado à mão do lado do Goals; repetir era pedir a mesma decisão duas
  vezes. **Idempotente** (a chave é o `jogo_id`), com um índice único parcial na
  BD como última rede contra duas sessões a arrancar ao mesmo tempo.
- **O que NUNCA faz:** criar eventos de jogos que já passaram; tocar num jogo já
  aberto ou já fechado (a data desses é o que aconteceu); adoptar um evento que
  não esteja em agenda; **apagar** seja o que for — um jogo que desapareça do
  Goals deixa cá o evento, que o admin apaga à mão, porque apagá-lo levava com
  ele as presenças e o consumo.
- Os eventos criados nascem sem tesoureiro; convocados e menu vêm dos de sempre,
  calculados **uma vez** antes do ciclo (ver comentário em
  `sincronizarJogosDoGoals`).
- **Nome do evento: `Sporting vs Adversário`** (`_calDescricao`), o mesmo formato
  dos criados à mão desde sempre. Já esteve com traço e o resultado foi a lista
  com dois formatos ao mesmo tempo — se mexeres no separador, mexe nos eventos
  que já lá estão.
- Só diz alguma coisa ao utilizador quando **fez** alguma coisa
  (`_jogoSincResumo`): avisar "0 novidades" a cada arranque era só ruído. O
  detalhe vai sempre para a consola.

## Jogos futuros no ecrã: o calendário da época não pode encher a lista
Com o calendário criado de uma vez, "eventos em aberto" passou a incluir meia
época de jogos por acontecer. Por isso:
- **Ecrã inicial** (`renderInicio`, no `index.html`): "Em aberto" só leva os
  jogos **abertos** (ver secção seguinte). Os que estão por abrir vivem em
  **"Próximos Jogos em Alvalade"** (`proximosAlvalade()`), no **fim do ecrã, a
  seguir ao Consumo** — é agenda, não é trabalho por fazer, e não deve empurrar
  para baixo o que precisa de atenção hoje. `FUTUROS_A_MOSTRAR` (2) à vista, o
  resto atrás de "mais N jogos". A secção aparece **sempre**, mesmo sem jogos: é
  lá que há onde dizer que não há nenhum. Os jogos entram aqui **sozinhos**, a
  partir do calendário do Goals — esta app já não tem botão de sincronizar.
  O **desenho do cartão** (`cardFuturo`, classe `.sbj` por cima do `.sbi-fut`) é
  o da lista de jogos do Goals — data · hora/dia da semana · escudo ·
  adversário/competição · presenças · símbolo da competição —, porque é o mesmo
  calendário nas duas apps. Três diferenças de propósito: **sem** ícone
  casa/fora (aqui é sempre Alvalade), **sem** resultado (é sempre jogo por
  acontecer) e as contagens de presenças ficam **antes** do símbolo da
  competição, por serem matéria só desta app. As caixas de largura fixa são o
  que mantém as linhas todas alinhadas quando falta a hora ou o símbolo.
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
- **Vou / Não vou ao Sá:** na mesma folha, qualquer convocado marca se vai à
  refeição a seguir ao jogo ("Vais ao Sá?") — e isso mexe na lista de
  convocados do evento (`ev.amigos`), que é a mesma que depois aparece na
  grelha de amigos e conta para o consumo. Quem pode editar o evento grava
  pelo caminho normal (PATCH); os outros vão pela função `marcar_presenca` do
  servidor (`sbMarcarPresenca`), SECURITY DEFINER, que **só** acrescenta ou
  tira dessa lista os nomes da conta autenticada — dar UPDATE em `eventos` a
  um convocado deixava-o mexer na fatura, no pagador e no substituto.
- **Vou / Não vou ao jogo** (`db/vai-jogo.sql`, coluna `eventos.vai_jogo`,
  jsonb `{"Nome": true|false}`): pergunta **separada** da anterior — ir ao
  jogo sem ir ao Sá acontece com frequência, e o que interessa aqui é gerir
  lugares, não o consumo. Por **defeito** segue a resposta ao Sá
  (`vaiAoJogoPessoa()`: só olha para `ev.jogo` se houver entrada explícita
  para o nome, senão cai em `ev.amigos`) — por isso só se grava o que é
  **explícito**, nunca o defeito calculado, senão o defeito parava de seguir o
  Sá para quem nunca tocou nesta pergunta. Mesmo padrão de permissões que o
  Sá: PATCH normal para quem edita o evento, `marcar_presenca_jogo`
  (`sbMarcarPresencaJogo`) SECURITY DEFINER para os outros. `VAI_JOGO_COL`
  degrada como as outras colunas opcionais — sem a migração, some-se a
  segunda pergunta e fica só a de sempre.
  A resposta "não vou" **notifica o grupo todo** (`sbNotificarGamebox`): o
  lugar na gamebox fica potencialmente livre e isso só serve a quem o quiser
  antes do dia. Só dispara na **mudança** para "não vou" — carregar duas vezes
  no mesmo botão não volta a tocar os telemóveis todos.
- **A que horas podes estar no Sá** (`db/sa-hora.sql`, coluna
  `eventos.sa_hora`, jsonb `{"Nome": "HH:MM"}`): terceira pergunta da folha,
  só para quem já disse que **vai** ao Sá. Saber quem vai nunca chegou para
  marcar a mesa — o que falta é a hora do **último a poder chegar**, e é essa
  que `mesaSaEvento()` calcula e a folha mostra em destaque, com quantas
  respostas ainda faltam (a hora ainda pode recuar). A lista completa
  (`_saHorasHTML`) fica **sempre** visível a quem entra no jogo, não só no
  momento de responder. Quem **desmarca** a ida ao Sá perde a hora
  (`marcarPresenca`), senão a mesa ficava à espera de quem já disse que não ia.
  Cada resposta notifica **só** o `GESTOR_MESA_SA` (o Barrona, no `app.js`), que
  é quem trata da marcação — mandá-la ao grupo era ruído a cada resposta.
  Mesmo padrão de permissões e de degradação: PATCH normal para quem edita o
  evento, `marcar_hora_sa` (`sbMarcarHoraSa`) SECURITY DEFINER para os outros,
  e sem a migração `SA_HORA_COL=false` esconde a pergunta e volta à lista de
  nomes de sempre. O formato `HH:MM` é validado nos **dois** lados: é o único
  texto escolhido pelo utilizador que chega ao corpo de uma notificação.
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

## Armadilhas do CSS (já mordidas)
- **`input, select { appearance: none }`** (para os campos de texto) apaga o
  desenho nativo das **checkboxes**: elas mudam de estado mas ficam visualmente
  iguais — carrega-se e "não acontece nada". Qualquer checkbox nova precisa de
  `appearance: checkbox` e de desfazer padding/borda/fundo/cantos herdados (ver
  `.conv-row input`).
- **`hidden` não colapsa nada** dentro do ecrã inicial: `.sbi-list{display:flex}`
  é regra de autor e ganha ao `[hidden]` do browser — o bloco "mais N jogos"
  aparecia todo na mesma. Resolve-se com `.sbi-list[hidden]{display:none}` (já lá
  está); qualquer lista nova com `display` próprio precisa do mesmo par.
- **`display:grid` + `place-items:center` numa caixa de imagem parte o
  `max-height:100%`.** A linha do grid é dimensionada PELO item, por isso a
  percentagem fica cíclica e o browser ignora-a — o `object-fit` nunca chega a
  entrar. Um escudo alto (o Marítimo, com a faixa "Madeira") desenhava-se a
  30x75 numa caixa de 30x30, a transbordar e a parecer 22px descaído; um SVG
  com tamanho intrínseco pequeno ficava pequeno em vez de encher a caixa. Numa
  caixa de imagem usa **`display:flex`** e dá à `img` **`width:100%;
  height:100%;object-fit:contain`** — assim a caixa manda sempre, seja qual for
  o ficheiro (ver `.sbj-logo`/`.sbj-cico`, que recebem SVG de terceiros).
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
