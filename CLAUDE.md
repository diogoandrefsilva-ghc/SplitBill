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
  Custom confirm modal · **Pagador & Contas (dívidas)** · Page switching · FAB · **Core: cálculo de saldos** (dívidas + pagamentos) · Render · **Ecrã do evento** (quadrantes, folhas, o + em dois passos) · Payment form · Edit Ordem inline · **Importar Fatura** (foto/PDF → Gemini → conferência artigo a artigo) · **Calendário do Sporting** (ler `goals.jogos`, guardar o mínimo cá) · **Jogo aberto & presenças** (abrir o jogo, vou/não vou, hora do Sá) · Configs · **Supabase** (+ Sessão/refresh do token, Permissões, Agregação global, IDs únicos, Equivalências amigo↔conta)
- `fatura-restaurante.ts` — Edge Function (Deno) que lê a fatura com o Gemini. **Não corre no site**: vive no Supabase, faz-se deploy à parte (`supabase functions deploy fatura-restaurante`). É irmã da `fatura-ocr` da FestasBV — mesmo projeto Supabase, schema e prompt diferentes.
- `push-notificar.ts` — a outra Edge Function, a das notificações Web Push. Também **não corre no site** (`supabase functions deploy push-notificar`): se mexeres nos `tipo` daqui, o texto novo só aparece depois desse deploy. O corpo da notificação é escolhido **lá**, nunca vem livre do cliente — só nomes, valores e as horas (a do Sá e a da mesa, validadas `HH:MM` dos dois lados) são interpoladas.
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
- **A folha tem de caber num ecrã** (`_jogoSheetHTML`): quem a abre vem
  responder e ver a que horas é a mesa, e isso não pode estar atrás de scroll.
  Daí o desenho actual — a data numa linha de leitura com um lápis
  (`jogoSheetMostrarData`) em vez de um campo sempre à vista, as perguntas
  como linhas de um cartão (`_jfLinha`/`_jfSeg`) em vez de títulos com
  botões de largura inteira — e as duas que só interessam a parte do grupo (a
  hora do Sá, a gamebox) só a essa parte aparecem, a data e a hora a gravar **ao sair do campo**
  (`onblur`) em vez de um botão Guardar cada — o `change` do seletor dispara a
  cada roda que se mexe, e gravar aí era um PATCH e uma notificação por volta,
  com o redesenho a fechar o seletor na cara de quem o estava a usar; e quem vai numa **tabela só** — nome · Sá · horas · jogo · box
  (`_jfTabelaHTML`) — **dobrada** (`_jfFoldHTML`, estado em `_jfFold` para não
  fechar a cada resposta). A tabela substituiu duas listas para as mesmas
  pessoas: quem ia ao jogo sem ir ao Sá aparecia numa e faltava na outra, e
  cruzá-las era de cabeça. **Coisa nova na folha = ver o que
  sai**, senão volta a crescer. As notas de rodapé (o que abrir o jogo faz, o que
  o Preparar faz) saíram por isso mesmo: os botões já o dizem.
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
  A resposta "não vou" **já não notifica ninguém** — quem avisa o grupo é a
  pergunta da gamebox, a seguir.
- **Gamebox disponível?** (`db/gamebox.sql`, coluna `eventos.gamebox`, jsonb
  `{"Nome": true|false}`): quarta pergunta da folha, e **só aparece a quem já
  disse que NÃO vai ao jogo** — quem lá vai ocupa a própria box, e por isso
  passar a "vou" **apaga** a resposta (`marcarPresencaJogo`), como desmarcar a
  ida ao Sá apaga a hora. Ao contrário do "vais ao jogo?", aqui o silêncio
  **nunca** vale por resposta: sem um sim explícito não há box livre
  (`gameboxDisponivelPessoa`). Ninguém dá a box sem o dizer — e quem a dá pode
  fazê-lo só até certa hora, ou até alguém a pedir.
  **É esta resposta que notifica o grupo todo** (`sbNotificarGamebox`, tipo
  `gamebox` na `push-notificar.ts`), e já não o "não vou ao jogo": não ir ao
  jogo e a box ficar livre são coisas diferentes, e o grupo era chamado por
  lugares que muitas vezes não existiam — um aviso que costuma não dar em nada
  deixa de se ler. Só na **mudança** para disponível; retirar a box não toca em
  telemóvel nenhum. Mesmo padrão de permissões e de degradação das outras:
  PATCH normal para quem edita o evento, `marcar_gamebox` (`sbMarcarGamebox`)
  SECURITY DEFINER para os outros — e essa **volta a confirmar no servidor**
  que quem vai ao jogo não a pode disponibilizar. Sem a migração,
  `GAMEBOX_COL=false`, a pergunta some-se e a tabela perde a coluna da box.
  As boxes livres contam-se na linha dobrada da folha e numa **pílula própria**
  no cartão dos Próximos Jogos (`.sbi-box`), que só aparece quando há alguma.
- **A que horas podes estar no Sá** (`db/sa-hora.sql`, coluna
  `eventos.sa_hora`, jsonb `{"Nome": "HH:MM"}`): terceira pergunta da folha,
  só para quem já disse que **vai** ao Sá. Saber quem vai nunca chegou para
  marcar a mesa — falta saber a que horas cada um lá pode estar. A folha mostra
  o **resumo dos votos** e mais nada (`_horasResumoHTML`, `_horasAgrupadas`):
  cada hora com quanta gente a votou, "17:30 (2p)", e quantos ainda não
  responderam. **Não conclui hora nenhuma** — já concluiu (a do último a poder
  chegar, `mesaSaEvento`, entretanto apagada) e dizia menos do que os votos:
  com uns a chegar às 16:00 e outros às 19:00 a mesa não se pede a uma hora só,
  e quem a marca lê melhor o mapa. O nome a nome está na tabela dobrada
  (`_quemVaiHTML`) — ver abaixo. Quem **desmarca** a ida ao Sá perde a hora
  (`marcarPresenca`), senão a mesa ficava à espera de quem já disse que não ia.
  Cada resposta notifica **só** o `GESTOR_MESA_SA` (o Barrona, no `app.js`), que
  é quem trata da marcação — mandá-la ao grupo era ruído a cada resposta.
  Mesmo padrão de permissões e de degradação: PATCH normal para quem edita o
  evento, `marcar_hora_sa` (`sbMarcarHoraSa`) SECURITY DEFINER para os outros,
  e sem a migração `SA_HORA_COL=false` esconde a pergunta e volta à lista de
  nomes de sempre.
- **A hora a que a mesa ficou marcada** (`db/mesa-hora.sql`, coluna
  `eventos.mesa_hora`, texto `HH:MM`): as horas acima são as que cada um
  **pode**; esta é a que o restaurante **deu**. Quem a põe é quem trata da
  marcação (`GESTOR_MESA_SA`), o admin ou o substituto do evento — é uma hora
  do grupo, não uma resposta pessoal, daí a permissão apertada
  (`podeMarcarMesa`, e do lado do servidor a `marcar_mesa_hora`, que confirma o
  mesmo). Na folha fica **em destaque** por cima dos votos, e com ela marcada
  os votos ficam mais discretos (`.jf-mesa.marcada`): já cumpriram o que
  tinham a cumprir. Quem não a pode marcar não vê linha nenhuma enquanto a mesa
  estiver por marcar. **Se a mesa passar a ser de outra pessoa muda-se em dois
  sítios:** `GESTOR_MESA_SA` no `app.js` (quem recebe a notificação das horas) e
  a chave `gestor_mesa` em `splitbill.config` (quem pode gravar). Marcar a mesa
  **notifica o grupo** (`sbNotificarMesa`, tipo `mesa_marcada` na
  `push-notificar.ts`) — é o inverso do `hora_sa`, que recolhe: este anuncia, e
  é a resposta que toda a gente esperava. Só na **mudança** para uma hora nova:
  desmarcar não toca em telemóvel nenhum, e gravar a mesma hora outra vez
  também não. Sem a migração, `MESA_HORA_COL=false` e a folha volta a mostrar
  só o resumo dos votos. O formato `HH:MM` é validado nos **dois** lados: é o único
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

## O ecrã do evento: quatro quadrantes, sem scroll de página
O evento era uma página comprida: adicionar ordem, ordens registadas, ofertas,
resumo da conta, configurações. Para saber quanto ia a mesa e quem devia o quê
andava-se para baixo e para cima. Agora cabe tudo num ecrã.
- **Total da mesa** em cima, e por baixo a grelha: **Ordens · Ofertas · Por item
  · Por pessoa**. As Ordens ocupam a **linha de cima inteira** e a coluna das
  **Ofertas só nasce quando existe alguma** (`ev-g4` no `#ev-grid`) — na maior
  parte dos jogos não há ofertas, e um quadrante permanentemente vazio é pior do
  que não o ter. Sem ofertas, a linha inteira dá para pôr cada ordem numa linha
  só (`.ev-wide`: item · quem · valor) em vez de duas.
- **O scroll vive DENTRO de cada quadrante** (`.ev-rows`), nunca na página: a
  altura da grelha é calculada em `evAjustarAltura()` a partir do que sobra do
  ecrã, e depois corrigida pelo que ainda estiver a transbordar (o padding de
  baixo muda com o safe-area). Como a página não desliza, não há dois scrolls a
  disputar o mesmo dedo. **Coisa nova por cima da grelha = a grelha encolhe
  sozinha**, não é preciso mexer em contas.
- **Toca-se na LINHA, não no quadrante.** Chegou a estar pensado um zoom por
  quadrante; o que ele servia era o detalhe de UMA linha, e isso resolve-se numa
  folha pequena (`#ev-sheet-linha`): quem consumiu e quanto lhe calha, com
  Apagar/Editar nas ordens. O Editar reaproveita o `toggleEditOrdem()` de sempre
  — a folha cria o `#ordem-<id>` onde o painel de edição se desenha.
- **O + abre em dois passos**: artigo (grelha de símbolos) → quem consome. O
  artigo escolhido **avança sozinho** para o passo 2, onde estão a quantidade,
  as pessoas e o total antes de registar. Só serve para **consumo**: a oferta
  tem caminho próprio (a seguir).
- **A oferta não entra pelo +.** O + lança consumo; uma oferta **não acrescenta
  nada à mesa — atua sobre o que lá está**, e misturar as duas coisas no mesmo
  botão confundia. Tem botão próprio (`#ev-fab-of`, dourado e mais pequeno, ao
  lado do +, e só aparece com ordens já lançadas), que abre a lista do que foi
  pedido **por pessoa**: escolhe-se quem oferece e **pica-se** o que essa pessoa
  assume. Tocar outra vez devolve a linha.
  Cada linha picada é UM registo em `estado.ofertas` com **`ordemId`** e **um só
  nome** em `para` — assim o valor deduzido é exatamente a quota daquela pessoa
  naquela ordem, e não uma média. As ofertas **antigas** (sem `ordemId`, com
  vários nomes em `para`) continuam a valer: o `calcularSaldoOfertas()` é o
  mesmo para as duas, e na lista as linhas que elas cobrem aparecem bloqueadas.
  **`_evRepararOfertas()`** corre a seguir a apagar e a editar uma ordem: uma
  oferta que aponte para uma ordem que desapareceu, ou de que a pessoa saiu, vai
  atrás dela; se a ordem mudou de preço ou de gente, o valor é refeito. Sem isso
  ficava a deduzir um valor que já não existe. O quadrante mostra **uma linha
  por artigo oferecido** (`1× Bifana · Barrona → Nuno`) — as ofertas nunca são
  muitas, e "2 artigos a 2 pessoas" obrigava a abrir para saber o quê e a quem.
  Tocar abre a folha de quem oferece, que é **só de leitura**: mexer (juntar,
  tirar, devolver tudo) faz-se num sítio só — o "Editar oferta" leva ao ecrã de
  picar, onde se vê a lista inteira e não apenas o que já foi assumido.
- **No Por pessoa há duas coisas por linha, e não uma:** à esquerda o que a
  oferta faz (`🎁 oferece +€6.00` / `🎁 recebe −€3.50`) — essa vale, não se
  rasura; à direita, **por baixo do total oficial**, o que essa pessoa pagaria
  se não houvesse oferta nenhuma (`.ev-row-vs`, rasurado). É a quarta célula da
  grelha da linha (`grid-template-areas: "t v" "s x"`).
  **O botão da barra abre sempre em branco**: é para uma oferta NOVA. Reabrir
  com a pessoa da vez anterior fazia parecer que estava a editar a primeira.
  Mexer nas que já existem faz-se pelo quadrante (`evPicarMais`) — e o nome vai
  por ÍNDICE no `onclick`, nunca por `JSON.stringify`, que mete aspas duplas
  dentro de um atributo delimitado por aspas duplas e parte o clique num "Zé".
- **Símbolos dos artigos** (`evIconeArtigo`): o menu é escrito à mão em cada
  evento, por isso o símbolo vem do NOME (`_EV_ICO`, uma lista de padrões) e o
  que não é reconhecido fica com as **iniciais** — melhor do que um ícone
  errado. Atenção ao `\b` do JS, que é ASCII: `\bchá\b` NÃO tem fronteira a
  seguir ao "á" e não casa nada (era o Chá verde a receber o copo de vinho).
- **Barra inferior** (`.ev-bar`, fixa, só na página do evento): cinco lugares —
  `Gerir · Oferecer · + · Conta · Relatórios` — todos com nome por baixo do
  ícone, e o + ao centro. Já foram três círculos de tamanhos e desenhos
  diferentes com dois rótulos só nos de fora; ficava desarrumado e os do meio
  não se percebiam. Agora só o + é cheio (um quadrado de cantos redondos, da
  mesma família dos cartões) e **assenta na barra em vez de a romper** — não
  precisa de subir para se ver que é o principal. O único que foge ao cinzento é
  o **Oferecer**, a dourado, por ser o que mexe na conta dos outros.
  Cada botão tem **`grid-column` fixo pela posição** (`:nth-child`): esconder um
  (o Oferecer sem ordens, o + em modo leitura) deixa a célula vazia em vez de
  arrastar os outros — sem isso o + saía do centro.
  O que se acerta antes do jogo (convocados, menu, substituto) está no
  **Gerir**; a fatura na **Conta**; os dois PDFs em **Relatórios**.
- **O cartão do total da mesa** é uma linha só, com o valor à direita: as
  contagens de pessoas e de registos que lá estavam já vivem nas pílulas de cada
  quadrante, e o que se ganha em altura vai todo para a grelha.
- **O que NÃO mudou, e é o que segura isto tudo:** os formulários antigos
  continuam no DOM, dentro das folhas, com os **mesmos ids**
  (`section-adicionar`, `section-ofertas`, `#item`, `#quantidade`,
  `#amigos-grid`, `fatura-section`, `section-config`…). Quem grava continua a
  ser o `adicionarOrdem()`/`adicionarOferta()`, e as permissões
  (`aplicarPermissoesEdicao`, `atualizarReadOnly`) continuam a apanhar as mesmas
  secções. **Não trocar esses ids** por uns mais bonitos: era reescrever as
  permissões e a escrita no Supabase de graça.
- `evToast()`: o `#mensagem` de sempre vive agora dentro da folha do +. Com a
  folha fechada a mensagem não se via, por isso o `mostrarMensagem()` passa a
  um aviso flutuante quando o `#mensagem` está escondido.

## Armadilhas do CSS (já mordidas)
- **`input, select { appearance: none }`** (para os campos de texto) apaga o
  desenho nativo das **checkboxes**: elas mudam de estado mas ficam visualmente
  iguais — carrega-se e "não acontece nada". Qualquer checkbox nova precisa de
  `appearance: checkbox` e de desfazer padding/borda/fundo/cantos herdados (ver
  `.conv-row input`).
- **Texto pequeno dentro de um `button` herda o peso e a família do botão.**
  Uma legenda cinzenta debaixo de um título, dentro de um botão de lista, saía a
  600 e em Barlow Condensed como o título (ver `.ev-lrow-i span`, que repõe as
  duas). O mesmo vale para as classes: `.grow-row`/`.grow-ic` só existiam no
  mockup — usá-las na app deixou os botões a cair no `button` global, verdes,
  em maiúsculas e com os SVG sem tamanho (ícones gigantes).
- **O `button` global é UPPERCASE com `letter-spacing`.** Qualquer botão novo
  herda-o: as linhas dos quadrantes (que são botões) saíam em maiúsculas e os
  nomes dos artigos truncavam a meio. Botão que mostre um NOME (de artigo, de
  pessoa) precisa de `text-transform:none; letter-spacing:normal` — a mesma
  razão pela qual o `.sbi-tap` do ecrã inicial já os desfaz.
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
