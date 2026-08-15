let amigos = [];

let menu = {};

let historico = [];
let eventoAtualId = null;
let modoReadOnly = false;

let estado = {
    ordens: [],
    ofertas: [],
    totalFatura: null,
    fatura: null,          // detalhe lido da fatura (artigo a artigo), guardado no evento
    descricaoEvento: '',
    pagador: '',
    dividas: {},
    amigosSelecionados: new Set(),
    ofertaAmigos: new Set()
};

// Inicializar
function init() {
    carregarHistoricoLocal();
    carregarPagamentos();
    carregarDoLocalStorage(); // cleans up legacy keys

    // Migrate legacy events: add pagador and dividas for closed events
    let migrated = false;
    historico.forEach(ev => {
        if (ev.totalFatura && !ev.pagador) {
            ev.pagador = (ev.amigos && ev.amigos.length > 0) ? ev.amigos[0] : '';
            migrated = true;
        }
        if (ev.totalFatura && ev.pagador && (!ev.dividas || Object.keys(ev.dividas).length === 0)) {
            ev.dividas = {};
            const contaFinal = calcularContaFinalEvento(ev);
            Object.keys(contaFinal).forEach(pessoa => {
                if (pessoa !== ev.pagador && contaFinal[pessoa] > 0.005) {
                    const val = Math.round(contaFinal[pessoa] * 100) / 100;
                    ev.dividas[pessoa] = { valor: val };
                }
            });
            migrated = true;
        }
        // Clean up old 'pago' field from dividas if present
        if (ev.dividas) {
            let hadPago = false;
            Object.keys(ev.dividas).forEach(p => {
                if (ev.dividas[p].pago !== undefined) {
                    // If was marked pago and no payment exists yet, create one
                    if (ev.dividas[p].pago) {
                        const existing = pagamentos.find(pg => pg.eventoId === ev.id && pg.pessoa === p);
                        if (!existing) {
                            pagamentos.push({
                                id: Date.now() + Math.random() * 1000 | 0,
                                pessoa: p, valor: ev.dividas[p].valor, tipo: 'evento', eventoId: ev.id,
                                data: ev.data || 'migrado'
                            });
                        }
                    }
                    delete ev.dividas[p].pago;
                    hadPago = true;
                }
            });
            if (hadPago) migrated = true;
        }
    });

    // Deduplicate pagamentos: remove entries with same pessoa + eventoId + tipo='evento'
    const pgtoSeen = new Set();
    const pgtoClean = [];
    let hadDuplicates = false;
    pagamentos.forEach(p => {
        if (p.tipo === 'evento' && p.eventoId) {
            const key = p.pessoa + '|' + p.eventoId;
            if (pgtoSeen.has(key)) { hadDuplicates = true; return; }
            pgtoSeen.add(key);
        }
        pgtoClean.push(p);
    });
    if (hadDuplicates) {
        pagamentos = pgtoClean;
        migrated = true;
    }
    if (migrated) {
        salvarHistoricoLocal();
        salvarPagamentos();
    }

    ghLoadCfg();
    ghUpdateSyncBtn();

    // Load saved event (where the user was), or the most recent, or start fresh
    if (historico.length > 0) {
        let alvo = null;
        try {
            const savedEv = localStorage.getItem('sb_evento');
            if (savedEv != null) alvo = historico.find(e => String(e.id) === String(savedEv));
        } catch(e) {}
        carregarEvento(alvo || historico[historico.length - 1]);
    } else {
        // No history at all — blank state, no event created yet
        amigos = [];
        menu = {};
    }

    if (estado.descricaoEvento) document.getElementById('descricao-evento').value = estado.descricaoEvento;
    if (estado.totalFatura) {
        document.getElementById('total-fatura').value = estado.totalFatura;
        atualizarAjuste();
    }
    renderHistoricoDropdown();
    renderDropdownItens();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderConfigAmigos();
    renderConfigMenu();
    renderPagadorSelect();
    atualizarUI();
    atualizarNavBadge();

    // Restaurar o separador onde o utilizador estava (sobrevive ao reload do PWA)
    let savedPag = null;
    try { savedPag = localStorage.getItem('sb_pagina'); } catch(e) {}
    if (['inicio', 'eventos', 'pagamentos', 'geral'].includes(savedPag)) mudarPagina(savedPag);
    else mudarPagina('inicio');

    document.getElementById('item').addEventListener('change', atualizarPreco);
    document.getElementById('quantidade').addEventListener('change', atualizarPreco);

    // Prompt to sync from GitHub on load
    ghPromptSync();
}

// Deixa o estado de trabalho sem evento nenhum (não há histórico, ou o evento
// aberto deixou de existir). Tem de limpar TUDO o que o carregarEvento enche:
// se ficar lixo em memória, o próximo salvarNoLocalStorage() carimba-o no
// evento seguinte.
function limparEstadoEvento() {
    eventoAtualId = null;
    try { localStorage.removeItem('sb_evento'); } catch(e) {}
    estado.ordens = [];
    estado.ofertas = [];
    estado.totalFatura = null;
    estado.fatura = null;
    estado.descricaoEvento = '';
    estado.pagador = '';
    estado.dividas = {};
    estado.amigosSelecionados.clear();
    estado.ofertaAmigos.clear();
    amigos = [];
    menu = {};
    modoReadOnly = false;
    const d = document.getElementById('descricao-evento'); if (d) d.value = '';
    const t = document.getElementById('total-fatura'); if (t) t.value = '';
}

// Helper: load an event's data into the working state
function carregarEvento(ev) {
    eventoAtualId = ev.id;
    try { if (ev.id != null) localStorage.setItem('sb_evento', String(ev.id)); } catch(e) {}
    estado.ordens = ev.ordens ? JSON.parse(JSON.stringify(ev.ordens)) : [];
    estado.ofertas = ev.ofertas ? JSON.parse(JSON.stringify(ev.ofertas)) : [];
    estado.totalFatura = ev.totalFatura || null;
    estado.fatura = ev.fatura ? JSON.parse(JSON.stringify(ev.fatura)) : null;
    estado.descricaoEvento = ev.descricao || '';
    estado.pagador = ev.pagador || '';
    estado.dividas = ev.dividas ? JSON.parse(JSON.stringify(ev.dividas)) : {};
    amigos = ev.amigos ? JSON.parse(JSON.stringify(ev.amigos)) : [];
    // Evento sem convocados e sem nada lançado: não há de onde os deduzir (é o
    // caso dos eventos criados antes de db/convocados-menu.sql). Usa-se a
    // sugestão por defeito, como já se faz com o menu — assim que houver ordens
    // ou a lista for guardada, é essa que manda.
    if (amigos.length === 0 && estado.ordens.length === 0 && estado.ofertas.length === 0) {
        amigos = amigosPorDefeito();
        if (estado.pagador && !amigos.includes(estado.pagador)) amigos.unshift(estado.pagador);
    }
    // O menu pode não estar persistido na BD; se vier vazio, reconstrói-se a partir de
    // todos os eventos (preço mais recente) para o dropdown de artigos funcionar.
    menu = (ev.menu && Object.keys(ev.menu).length) ? JSON.parse(JSON.stringify(ev.menu)) : menuAgregadoGlobal();
    modoReadOnly = !!ev.totalFatura;
    // A conferência da fatura é de um evento concreto — ao trocar de evento o
    // painel fecha-se, senão ficavam comparações da conta anterior no ecrã.
    if (typeof faturaFecharRecon === 'function') faturaFecharRecon();
    document.getElementById('descricao-evento').value = estado.descricaoEvento;
    document.getElementById('total-fatura').value = estado.totalFatura || '';
    renderPagadorSelect();
    if (estado.totalFatura) atualizarAjuste();
    else { document.getElementById('ajuste-info').style.display = 'none'; }
}

function renderDropdownItens() {
    const select = document.getElementById('item');
    select.innerHTML = '<option value="">-- Seleciona um item --</option>';
    
    Object.keys(menu).sort().forEach(item => {
        const option = document.createElement('option');
        option.value = item;
        option.textContent = `${item} (€${menu[item].toFixed(2)})`;
        select.appendChild(option);
    });
}

function atualizarPreco() {
    const item = document.getElementById('item').value;
    const quantidade = parseInt(document.getElementById('quantidade').value || 1);
    
    if (item && menu[item]) {
        const precoUnitario = menu[item];
        const precoTotal = precoUnitario * quantidade;
        // Apenas para lógica interna, não exibe
    } else {
        // Item não selecionado
    }
}

// Abrevia o primeiro nome ("Paulo Conceição" -> "P. Conceição").
// Nomes simples (uma palavra) ficam inalterados.
function abreviarPrimeiroNome(nome) {
    const partes = String(nome).trim().split(/\s+/);
    if (partes.length < 2) return nome;
    return partes[0].charAt(0).toUpperCase() + '. ' + partes.slice(1).join(' ');
}
let _medirCanvasCtx = null;
function _larguraTexto(txt, font) {
    if (!_medirCanvasCtx) _medirCanvasCtx = document.createElement('canvas').getContext('2d');
    _medirCanvasCtx.font = font;
    return _medirCanvasCtx.measureText(txt).width;
}
// Texto a mostrar num botão de amigo: usa o nome completo se couber numa
// linha da caixa, senão abrevia o primeiro nome. (btn deve já estar no DOM.)
function nomeBotaoAmigo(nome, btn) {
    const abreviado = abreviarPrimeiroNome(nome);
    if (abreviado === nome) return nome;
    if (btn && btn.clientWidth) {
        const cs = getComputedStyle(btn);
        const avail = btn.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return _larguraTexto(nome, font) <= avail ? nome : abreviado;
    }
    // Sem layout disponível (caixa escondida): heurística por nº de caracteres.
    return nome.length > 13 ? abreviado : nome;
}

function renderAmigosBotoes() {
    const grid = document.getElementById('amigos-grid');
    grid.innerHTML = '';
    amigos.forEach(amigo => {
        const btn = document.createElement('button');
        btn.className = 'amigo-btn';
        btn.type = 'button';
        grid.appendChild(btn);
        btn.textContent = nomeBotaoAmigo(amigo, btn);
        btn.onclick = (e) => {
            e.preventDefault();
            btn.classList.toggle('selected');
            if (btn.classList.contains('selected')) {
                estado.amigosSelecionados.add(amigo);
            } else {
                estado.amigosSelecionados.delete(amigo);
            }
            // Auto-update quantidade to match number of selected friends
            const sel = document.getElementById('quantidade');
            const n = estado.amigosSelecionados.size;
            sel.value = Math.min(n, 20);
            atualizarBotaoOrdem();
        };
    });
}

function atualizarBotaoOrdem() {
    const qtd = parseInt(document.getElementById('quantidade').value || 0);
    const temAmigos = estado.amigosSelecionados.size > 0;
    const btn = document.getElementById('btn-adicionar-ordem');
    btn.disabled = qtd <= 0 || !temAmigos;
}

function atualizarBotaoOferta() {
    const qtd = parseInt(document.getElementById('oferta-qtd').value || 0);
    const temAmigos = estado.ofertaAmigos.size > 0;
    const btn = document.getElementById('btn-adicionar-oferta');
    btn.disabled = qtd <= 0 || !temAmigos;
}

// Atualiza só o espelho local do historico com as ordens atuais, sem disparar
// o autosave do evento inteiro (PATCH a `eventos` + upsert/prune de TODAS as
// ordens) — esse caminho precisa de permissão de editar o evento, que um
// convocado normal não tem. Usado por quem só grava a própria ordem.
function _sincronizarOrdensNoHistorico() {
    if (!eventoAtualId) return;
    const idx = historico.findIndex(e => e.id === eventoAtualId);
    if (idx >= 0) historico[idx].ordens = JSON.parse(JSON.stringify(estado.ordens));
    salvarHistoricoLocal();
}

function adicionarOrdem() {
    const item = document.getElementById('item').value.trim();
    const quantidade = parseInt(document.getElementById('quantidade').value || 1);

    if (!item) {
        mostrarMensagem('⚠️ Seleciona um item', false);
        return;
    }

    if (quantidade <= 0) {
        mostrarMensagem('⚠️ Quantidade tem que ser maior que 0', false);
        return;
    }

    if (estado.amigosSelecionados.size === 0) {
        mostrarMensagem('⚠️ Seleciona pelo menos um amigo', false);
        return;
    }

    const ev = historico.find(h => h.id === eventoAtualId);
    const podeTudo = podeEditarEventoAtual();
    const podePropria = !podeTudo && podeAdicionarOrdemPropria(ev);
    if (!podeTudo && !podePropria) {
        mostrarMensagem('⚠️ Sem permissão para adicionar ordens a este evento', false);
        return;
    }

    const precoUnitario = menu[item];
    const precoTotal = precoUnitario * quantidade;

    const ordem = {
        id: nextId(),
        item: item,
        quantidade: quantidade,
        precoUnitario: precoUnitario,
        precoTotal: precoTotal,
        amigos: Array.from(estado.amigosSelecionados),
        hora: new Date().toLocaleString('pt-PT', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})
    };
    if (podePropria) ordem.criadoPor = emailSessao();

    estado.ordens.push(ordem);
    if (podeTudo) {
        salvarNoLocalStorage();
    } else {
        _sincronizarOrdensNoHistorico();
        sbCriarOrdemPropria(ordem, eventoAtualId);
    }
    atualizarUI();

    // Limpar formulário
    document.getElementById('item').value = '';
    document.getElementById('quantidade').value = '0'; atualizarBotaoOrdem();
    document.querySelectorAll('.amigo-btn').forEach(btn => btn.classList.remove('selected'));
    estado.amigosSelecionados.clear();
    atualizarPreco();

    mostrarMensagem('✓ Ordem adicionada!', true);
}

function removerOrdem(id) {
    const ordem = estado.ordens.find(o => o.id === id);
    if (!ordem) return;

    const ev = historico.find(h => h.id === eventoAtualId);
    const podeTudo = podeEditarEventoAtual();
    if (!podeTudo && !ehOrdemPropria(ordem, ev)) {
        mostrarMensagem('⚠️ Só podes remover as tuas próprias ordens', false);
        return;
    }

    // Verificar se alguma oferta ficaria inválida
    const problemasOferta = [];
    estado.ofertas.forEach(oferta => {
        if (oferta.item !== ordem.item) return;
        oferta.para.forEach(destinatario => {
            if (!ordem.amigos.includes(destinatario)) return;
            // Verificar se este amigo tem o item noutras ordens (além desta)
            const temNoutras = estado.ordens.some(o =>
                o.id !== id && o.item === ordem.item && o.amigos.includes(destinatario)
            );
            if (!temNoutras) {
                problemasOferta.push(destinatario + ' (oferta de ' + oferta.quem + ')');
            }
        });
    });

    if (problemasOferta.length > 0) {
        const unicos = [...new Set(problemasOferta)];
        mostrarMensagem('❌ Não é possível eliminar: ' + unicos.join(', ') + ' ficaria sem ' + ordem.item + ' na conta mas tem oferta associada. Remove a oferta primeiro.', false);
        return;
    }

    estado.ordens = estado.ordens.filter(o => o.id !== id);
    if (podeTudo) {
        salvarNoLocalStorage();
    } else {
        _sincronizarOrdensNoHistorico();
        sbApagarOrdemPropria(id);
    }
    atualizarUI();
    mostrarMensagem('✓ Ordem removida', true);
}

function atualizarUI() {
    _atualizarUIInner();
    if(typeof atualizarReadOnly==='function') atualizarReadOnly();
    // A conferência da fatura compara-se com as ordens: se elas mudam (marcar o
    // artigo que faltava, corrigir uma quantidade), o painel refaz as contas.
    if(typeof faturaRenderRecon==='function' && estado.fatura) faturaRenderRecon();
}
function _atualizarUIInner() {
    // Lista de ordens
    const lista = document.getElementById('lista-ordens');
    if (estado.ordens.length === 0) {
        lista.innerHTML = '<p style="color: #7C8782; font-size: 13px; text-align: center;">Nenhuma ordem registada ainda</p>';
    } else {
        const _evAtual = historico.find(h => h.id === eventoAtualId);
        const _podeTudo = podeEditarEventoAtual();
        lista.innerHTML = estado.ordens.map(ordem => {
            const podeEditarEsta = !modoReadOnly && (_podeTudo || ehOrdemPropria(ordem, _evAtual));
            return `
            <div class="ordem" id="ordem-${ordem.id}" style="flex-wrap:wrap;">
                <div class="ordem-info">
                    <div class="ordem-item">${ordem.item} (${ordem.quantidade}x €${ordem.precoUnitario.toFixed(2)})</div>
                    <div class="ordem-amigos">${ordem.amigos.join(', ')}</div>
                    <div class="ordem-hora">${ordem.hora || ''}</div>
                </div>
                <div class="ordem-preco">€${ordem.precoTotal.toFixed(2)}</div>
                ${podeEditarEsta ? `<button class="secondary" style="width:28px;height:28px;padding:0;font-size:14px;border-radius:50%;margin-right:4px;" onclick="toggleEditOrdem(${ordem.id})">✏️</button><button class="ordem-delete" onclick="removerOrdem(${ordem.id})">×</button>` : ''}
            </div>
        `;
        }).join('');
    }

    // Cálculos
    const totalMesa = estado.ordens.reduce((sum, o) => sum + o.precoTotal, 0);
    document.getElementById('total-mesa').textContent = '€' + totalMesa.toFixed(2);

    // Contar pessoas
    const setPessoas = new Set();
    estado.ordens.forEach(ordem => {
        ordem.amigos.forEach(amigo => setPessoas.add(amigo));
    });

    document.getElementById('num-pessoas').textContent = setPessoas.size;
    document.getElementById('total-ordens').textContent = estado.ordens.length;

    // Conta por pessoa
    const contaPorPessoa = {};
    setPessoas.forEach(pessoa => contaPorPessoa[pessoa] = 0);

    estado.ordens.forEach(ordem => {
        const precoParaCadaUm = ordem.precoTotal / ordem.amigos.length;
        ordem.amigos.forEach(amigo => {
            contaPorPessoa[amigo] += precoParaCadaUm;
        });
    });

    // Render lista ofertas
    const listaOfertas = document.getElementById('lista-ofertas');
    if (estado.ofertas.length === 0) {
        listaOfertas.innerHTML = '<p style="color:#7C8782;font-size:13px;text-align:center;">Nenhuma oferta ainda</p>';
    } else {
        listaOfertas.innerHTML = estado.ofertas.map(o => `
            <div class="oferta">
                <div class="oferta-info">
                    <div class="oferta-desc">🎁 ${o.quem} oferece ${o.quantidade}x ${o.item}</div>
                    <div class="oferta-detalhe">A: ${o.para.join(', ')} · ${o.hora || ''}</div>
                </div>
                <div class="oferta-valor">€${o.precoTotal.toFixed(2)}</div>
                ${modoReadOnly ? '' : `<button class="ordem-delete" onclick="removerOferta(${o.id})">×</button>`}
            </div>
        `).join('');
    }

    // Conta por pessoa com saldo ofertas
    const saldoOfertas = calcularSaldoOfertas();
    // Merge all people from ordens + ofertas
    const todasPessoas = new Set([...setPessoas]);
    estado.ofertas.forEach(o => {
        todasPessoas.add(o.quem);
        o.para.forEach(p => todasPessoas.add(p));
    });

    const contaDiv = document.getElementById('conta-pessoas');
    if (todasPessoas.size === 0) {
        contaDiv.innerHTML = '<p style="color: #7C8782; font-size: 13px; text-align: center;">Sem dados ainda</p>';
    } else {
        const pessoas = Array.from(todasPessoas).sort();
        contaDiv.innerHTML = pessoas.map(pessoa => {
            const base = contaPorPessoa[pessoa] || 0;
            const delta = saldoOfertas[pessoa] || 0;
            const total = base + delta;
            const deltaStr = delta !== 0
                ? `<div class="detalhe-oferta">${delta > 0 ? '🎁 oferece' : '🎁 recebe'} ${delta > 0 ? '+' : ''}€${delta.toFixed(2)}</div>`
                : '';

            // Build consumo detail
            const consumos = {};
            estado.ordens.forEach(o => {
                if (o.amigos.includes(pessoa)) {
                    const share = o.quantidade / o.amigos.length;
                    consumos[o.item] = (consumos[o.item] || 0) + share;
                }
            });
            const consumoStr = Object.keys(consumos).sort().map(item => {
                const qtd = consumos[item];
                const qtdStr = Number.isInteger(qtd) ? qtd : qtd.toFixed(1);
                return `${qtdStr}× ${item}`;
            }).join(', ');

            return `
            <div class="pessoa-conta-final">
                <div class="linha-principal">
                    <span class="pessoa-nome">${pessoa}</span>
                    <span class="pessoa-valor-final">€${total.toFixed(2)}</span>
                </div>
                ${consumoStr ? `<div class="detalhe-consumo">${consumoStr}</div>` : ''}
                ${deltaStr}
            </div>`;
        }).join('');
    }

    // Total por item
    const totalPorItem = {};
    const qtdPorItem = {};
    estado.ordens.forEach(ordem => {
        if (!totalPorItem[ordem.item]) { totalPorItem[ordem.item] = 0; qtdPorItem[ordem.item] = 0; }
        totalPorItem[ordem.item] += ordem.precoTotal;
        qtdPorItem[ordem.item] += ordem.quantidade;
    });
    const itensDiv = document.getElementById('total-itens');
    if (estado.ordens.length === 0) {
        itensDiv.innerHTML = '<p style="color: #7C8782; font-size: 13px; text-align: center;">Sem dados ainda</p>';
    } else {
        const itens = Object.keys(totalPorItem).sort();
        itensDiv.innerHTML = itens.map(item => `
            <div class="pessoa-conta">
                <span class="pessoa-nome">${item} <span style="font-weight:400;color:#7C8782;font-size:12px;">(${qtdPorItem[item]}x)</span></span>
                <span class="pessoa-valor">€${totalPorItem[item].toFixed(2)}</span>
            </div>
        `).join('');
    }
    // Re-render configs so delete buttons always reflect current orders
    renderConfigAmigos();
    renderConfigMenu();
}


function renderOfertaDropdowns() {
    const selQuem = document.getElementById('oferta-quem');
    selQuem.innerHTML = '<option value="">Amigo</option>';
    amigos.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a; opt.textContent = a;
        selQuem.appendChild(opt);
    });

    const selItem = document.getElementById('oferta-item');
    selItem.innerHTML = '<option value="">-- Item --</option>';
    Object.keys(menu).sort().forEach(item => {
        const opt = document.createElement('option');
        opt.value = item;
        opt.textContent = `${item} (€${menu[item].toFixed(2)})`;
        selItem.appendChild(opt);
    });
}

function renderOfertaAmigos() {
    const grid = document.getElementById('oferta-amigos-grid');
    grid.innerHTML = '';
    amigos.forEach(amigo => {
        const btn = document.createElement('button');
        btn.className = 'amigo-btn';
        btn.type = 'button';
        grid.appendChild(btn);
        btn.textContent = nomeBotaoAmigo(amigo, btn);
        btn.onclick = (e) => {
            e.preventDefault();
            btn.classList.toggle('selected');
            if (btn.classList.contains('selected')) {
                estado.ofertaAmigos.add(amigo);
            } else {
                estado.ofertaAmigos.delete(amigo);
            }
            // Auto-update quantidade to match number of selected friends
            const sel = document.getElementById('oferta-qtd');
            const n = estado.ofertaAmigos.size;
            sel.value = Math.min(n, 20);
            atualizarBotaoOferta();
        };
    });
}

function adicionarOferta() {
    const quem = document.getElementById('oferta-quem').value;
    const item = document.getElementById('oferta-item').value;
    const qtd = parseInt(document.getElementById('oferta-qtd').value || 1);

    if (!quem) { mostrarMsgOferta('⚠️ Seleciona quem oferece', false); return; }
    if (!item) { mostrarMsgOferta('⚠️ Seleciona o item', false); return; }
    if (estado.ofertaAmigos.size === 0) { mostrarMsgOferta('⚠️ Seleciona a quem é oferecido', false); return; }
    if (estado.ofertaAmigos.has(quem)) { mostrarMsgOferta('⚠️ Quem oferece não pode estar na lista de quem recebe', false); return; }

    // Validar que cada destinatário tem o item nas ordens
    const semItem = Array.from(estado.ofertaAmigos).filter(amigo => {
        return !estado.ordens.some(o => o.item === item && o.amigos.includes(amigo));
    });
    if (semItem.length > 0) {
        mostrarMsgOferta('❌ ' + semItem.join(', ') + ' não ' + (semItem.length === 1 ? 'tem' : 'têm') + ' ' + item + ' na conta', false);
        return;
    }

    const precoTotal = menu[item] * qtd;

    estado.ofertas.push({
        id: nextId(),
        quem,
        item,
        quantidade: qtd,
        precoUnitario: menu[item],
        precoTotal,
        para: Array.from(estado.ofertaAmigos),
        hora: new Date().toLocaleString('pt-PT', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})
    });

    salvarNoLocalStorage();
    atualizarUI();

    // reset
    document.getElementById('oferta-quem').value = '';
    document.getElementById('oferta-item').value = '';
    document.getElementById('oferta-qtd').value = '0'; atualizarBotaoOferta();
    document.querySelectorAll('#oferta-amigos-grid .amigo-btn').forEach(b => b.classList.remove('selected'));
    estado.ofertaAmigos.clear();
    mostrarMsgOferta('🎁 Oferta adicionada!', true);
}

function removerOferta(id) {
    estado.ofertas = estado.ofertas.filter(o => o.id !== id);
    salvarNoLocalStorage();
    atualizarUI();
}

function mostrarMsgOferta(msg, ok) {
    const div = document.getElementById('mensagem-oferta');
    div.className = ok ? 'sucesso' : 'aviso';
    div.textContent = msg;
    setTimeout(() => { div.textContent = ''; div.className = ''; }, 3000);
}

function calcularSaldoOfertas() {
    // Returns { pessoa: delta } — positive = pays more (offered), negative = pays less (received)
    const saldo = {};
    estado.ofertas.forEach(oferta => {
        if (!saldo[oferta.quem]) saldo[oferta.quem] = 0;
        saldo[oferta.quem] += oferta.precoTotal; // quem oferece paga mais

        const share = oferta.precoTotal / oferta.para.length;
        oferta.para.forEach(p => {
            if (!saldo[p]) saldo[p] = 0;
            saldo[p] -= share; // quem recebe paga menos
        });
    });
    return saldo;
}

function salvarNoLocalStorage() {
    // Auto-save current state into historico
    if (eventoAtualId) {
        const idx = historico.findIndex(e => e.id === eventoAtualId);
        if (idx >= 0) {
            historico[idx].ordens = JSON.parse(JSON.stringify(estado.ordens));
            historico[idx].ofertas = JSON.parse(JSON.stringify(estado.ofertas));
            historico[idx].totalFatura = estado.totalFatura;
            historico[idx].fatura = estado.fatura ? JSON.parse(JSON.stringify(estado.fatura)) : null;
            historico[idx].descricao = estado.descricaoEvento;
            historico[idx].pagador = estado.pagador;
            historico[idx].dividas = JSON.parse(JSON.stringify(estado.dividas));
            historico[idx].amigos = JSON.parse(JSON.stringify(amigos));
            historico[idx].menu = JSON.parse(JSON.stringify(menu));
            // Update data field from first order — exceto se a data foi escolhida
            // manualmente na criação do evento (dataManual).
            if (!historico[idx].dataManual) {
                const dataEvento = dataDoEvento();
                historico[idx].data = dataEvento.toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric'});
            }
        }
    }
    salvarHistoricoLocal();
    ghScheduleAutoSave();
}

function carregarDoLocalStorage() {
    // Legacy — data now lives in historico_eventos only.
    // Clean up old keys on first run.
    localStorage.removeItem('conta_refeicao');
    localStorage.removeItem('config_amigos');
    localStorage.removeItem('config_menu');
}


function carregarHistoricoLocal() {
    const saved = localStorage.getItem('historico_eventos');
    if (saved) {
        try { historico = JSON.parse(saved); } catch(e) { historico = []; }
    }
}

function salvarHistoricoLocal() {
    localStorage.setItem('historico_eventos', JSON.stringify(historico));
}

function renderHistoricoDropdown() {
    // Update the hidden select (keep for compatibility)
    const sel = document.getElementById('historico-select');
    sel.innerHTML = '<option value="">📚 Histórico (' + historico.length + ' eventos)</option>';
    [...historico].reverse().forEach(ev => {
        const opt = document.createElement('option');
        opt.value = ev.id;
        opt.textContent = (ev.descricao || 'Sem nome') + ' — ' + ev.data;
        sel.appendChild(opt);
    });

    // Update toggle button label
    const label = document.getElementById('historico-toggle-label');
    if (label) label.textContent = '📚 Histórico (' + historico.length + ' evento' + (historico.length !== 1 ? 's' : '') + ')';

    // Update card panel
    const panel = document.getElementById('historico-panel');
    if (!panel) return;
    if (historico.length === 0) {
        panel.innerHTML = '<div class="historico-empty">Nenhum evento guardado</div>';
        return;
    }
    ensureDividasExist();
    const saldosForCards = calcularSaldos();
    panel.innerHTML = [...historico].reverse().map(ev => {
        const isAtual = ev.id === eventoAtualId;
        const _ep = (typeof _epocaLabel === 'function') ? _epocaLabel(ev.data) : '';
        const _dataEp = (ev.data || '—') + (_ep ? ' · ' + _ep : '');
        return `
            <div class="historico-card${isAtual ? ' ativo' : ''}" onclick="${isAtual ? '' : 'navegarHistorico(' + ev.id + ')'}">
                <div class="historico-card-nome">${ev.descricao || 'Sem nome'}</div>
                <span class="historico-card-data">${_dataEp}</span>
                ${isAdmin() ? `<button class="historico-card-del" onclick="apagarEvento(${ev.id}, event)" title="Apagar evento">🗑️</button>` : ''}
            </div>`;
    }).join('');
}

function toggleHistoricoPanel() {
    const panel = document.getElementById('historico-panel');
    const arrow = document.getElementById('historico-toggle-arrow');
    panel.classList.toggle('open');
    if (arrow) arrow.style.transform = panel.classList.contains('open') ? 'rotate(180deg)' : '';
}

/* ── Custom confirm modal ── */
let _modalResolve = null;

function mostrarModal(opts) {
    return new Promise(resolve => {
        _modalResolve = resolve;
        document.getElementById('modal-icon').textContent = opts.icon || '⚠️';
        document.getElementById('modal-title').textContent = opts.title || '';
        document.getElementById('modal-msg').innerHTML = opts.msg || '';
        const actions = document.getElementById('modal-actions');
        actions.innerHTML = '';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-cancel';
        cancelBtn.textContent = opts.cancelText || 'Cancelar';
        cancelBtn.onclick = () => { fecharModalComResultado(false); };
        actions.appendChild(cancelBtn);
        // Terceira escolha opcional (ex.: "Corrigir só no menu"), a par de
        // Cancelar/Confirmar — resolve com a string 'extra', sem mexer no
        // contrato true/false que os outros chamadores já usam.
        if (opts.extraText) {
            const extraBtn = document.createElement('button');
            extraBtn.className = 'modal-cancel';
            extraBtn.textContent = opts.extraText;
            extraBtn.onclick = () => { fecharModalComResultado('extra'); };
            actions.appendChild(extraBtn);
        }
        const confirmBtn = document.createElement('button');
        confirmBtn.className = opts.danger ? 'modal-danger' : 'modal-confirm';
        confirmBtn.textContent = opts.confirmText || 'Confirmar';
        confirmBtn.onclick = () => { fecharModalComResultado(true); };
        actions.appendChild(confirmBtn);
        document.getElementById('modal-overlay').classList.add('show');
    });
}

function fecharModalComResultado(result) {
    document.getElementById('modal-overlay').classList.remove('show');
    if (_modalResolve) { _modalResolve(result); _modalResolve = null; }
}

function fecharModal(event) {
    if (event.target === document.getElementById('modal-overlay')) {
        fecharModalComResultado(false);
    }
}

async function navegarHistorico(id) {
    if (!id) return;
    const ev = historico.find(e => e.id == id);
    if (!ev) return;
    mudarPagina('eventos');
    carregarEvento(ev);
    atualizarReadOnly();
    renderConfigAmigos();
    renderConfigMenu();
    renderDropdownItens();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
    atualizarUI();
    renderHistoricoDropdown();
    renderContas();
    // Close the panel after navigating
    const panel = document.getElementById('historico-panel');
    const arrow = document.getElementById('historico-toggle-arrow');
    if (panel) { panel.classList.remove('open'); }
    if (arrow) { arrow.style.transform = ''; }
    mostrarMensagem('✓ Evento carregado: ' + (ev.descricao || 'Sem nome'), true);
}

async function apagarEvento(id, ev_) {
    if (ev_ && ev_.stopPropagation) ev_.stopPropagation();
    if (!isAdmin()) { mostrarMensagem('⚠️ Apenas o administrador pode apagar eventos', false); return; }
    const ev = historico.find(e => e.id == id);
    if (!ev) return;

    const ok = await mostrarModal({
        icon: '🗑️',
        title: 'Apagar evento?',
        msg: 'Vais apagar <strong>' + (ev.descricao || 'Sem nome') + '</strong> (' + (ev.data || '—') + ').<br><br>Esta ação não pode ser anulada e remove também os pagamentos associados a este evento.',
        confirmText: 'Apagar',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;

    // Apagar no servidor PRIMEIRO e só mexer no local se pegar. Ao contrário,
    // um apagar que o servidor recusa desaparecia do ecrã na mesma e o evento
    // voltava na carga seguinte — e como entretanto se criava outro no lugar
    // dele, os eventos multiplicavam-se em vez de desaparecerem.
    if (!await sbApagarEvento(id)) return;

    // Remover o evento do histórico
    historico = historico.filter(e => e.id != id);

    // Remover pagamentos ligados a este evento
    const antesPg = pagamentos.length;
    pagamentos = pagamentos.filter(p => !(p.tipo === 'evento' && p.eventoId == id));

    salvarHistoricoLocal();
    if (pagamentos.length !== antesPg) salvarPagamentos();

    // Se apaguei o evento que estava aberto, carregar outro ou limpar o estado
    if (eventoAtualId == id) {
        if (historico.length > 0) carregarEvento(historico[historico.length - 1]);
        else limparEstadoEvento();
        atualizarReadOnly();
    }

    renderConfigAmigos();
    renderConfigMenu();
    renderDropdownItens();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
    atualizarUI();
    renderHistoricoDropdown();
    renderContas();
    ghScheduleAutoSave();
    mostrarMensagem('🗑️ Evento apagado', true);
}

// Abre a pop-up "Novo evento" (descrição, data, tesoureiro). O evento só é
// criado/persistido depois de confirmar — ver confirmarNovoEvento().
function novoEvento() {
    if (!isAdmin()) { mostrarMensagem('⚠️ Apenas o administrador pode criar eventos', false); return; }
    abrirNovoEventoModal();
}

// ── Pop-up de criação de evento ──
function _hojeIso() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function _isoParaDataPt(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric'});
    return m[3] + '/' + m[2] + '/' + m[1];
}

function abrirNovoEventoModal() {
    document.getElementById('ne-descricao').value = '';
    document.getElementById('ne-data').value = _hojeIso();
    // Tesoureiro: por defeito "eu" (nome associado à minha conta), depois todos os amigos conhecidos.
    const sel = document.getElementById('ne-tesoureiro');
    const eu = meusAmigos()[0] || '';
    const vistos = new Set(); const lista = [];
    [eu].concat(amigosAgregadoGlobal()).forEach(a => { if (a && !vistos.has(a)) { vistos.add(a); lista.push(a); } });
    sel.innerHTML = '<option value="">— Seleciona —</option>'
        + lista.map(a => `<option value="${a}"${a === eu ? ' selected' : ''}>${a}</option>`).join('');
    document.getElementById('novo-evento-overlay').classList.add('show');
    setTimeout(() => { try { document.getElementById('ne-descricao').focus(); } catch(e) {} }, 60);
}

function fecharNovoEventoModal(event) {
    if (event && event.target !== document.getElementById('novo-evento-overlay')) return;
    document.getElementById('novo-evento-overlay').classList.remove('show');
}

function confirmarNovoEvento() {
    const descricao = document.getElementById('ne-descricao').value.trim();
    const dataPt = _isoParaDataPt(document.getElementById('ne-data').value);
    const tesoureiro = document.getElementById('ne-tesoureiro').value;
    document.getElementById('novo-evento-overlay').classList.remove('show');
    criarEvento({ descricao, data: dataPt, tesoureiro });
    mudarPagina('eventos');
    mostrarMensagem('✓ Novo evento criado', true);
}

// Cria o evento, grava em localStorage + BD, e carrega-o no estado de trabalho.
function criarEvento(opts) {
    opts = opts || {};
    // Por defeito: todos os amigos de eventos anteriores e todos os artigos
    // (nos repetidos fica o preço mais recente).
    const novosAmigos = amigosPorDefeito();
    const tesoureiro = opts.tesoureiro || '';
    if (tesoureiro && !novosAmigos.includes(tesoureiro)) novosAmigos.unshift(tesoureiro);
    const novoMenu = menuAgregadoGlobal();

    const novoId = Date.now();
    const novoEvt = {
        id: novoId,
        descricao: opts.descricao || '',
        data: opts.data || new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric'}),
        dataManual: !!opts.data,   // data escolhida pelo utilizador — não recalcular a partir das ordens
        ordens: [],
        ofertas: [],
        totalFatura: null,
        fatura: null,
        pagador: tesoureiro,
        dividas: {},
        amigos: novosAmigos,
        menu: novoMenu
    };
    historico.push(novoEvt);
    salvarHistoricoLocal();

    // Load it
    carregarEvento(novoEvt);
    modoReadOnly = false;
    document.getElementById('historico-select').value = '';
    estado.amigosSelecionados.clear();
    estado.ofertaAmigos.clear();
    atualizarReadOnly();
    renderConfigAmigos();
    renderConfigMenu();
    renderDropdownItens();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
    atualizarUI();
    renderHistoricoDropdown();
    renderContas();
    // Close the panel
    const panel = document.getElementById('historico-panel');
    const arrow = document.getElementById('historico-toggle-arrow');
    if (panel) { panel.classList.remove('open'); }
    if (arrow) { arrow.style.transform = ''; }
    // Persistir já na BD, sem esperar pelo debounce de 2s: o evento nasce no
    // servidor com os convocados e o menu, mesmo sem uma única ordem lançada.
    sbGuardarEvento(novoEvt, { criar: true }).catch(() => {});
    return novoEvt;
}

function dataDoEvento() {
    // Use hora da primeira ordem, senão now
    if (estado.ordens.length > 0 && estado.ordens[0].hora) {
        // hora format: "dd/mm hh:mi" — parse to Date
        const h = estado.ordens[0].hora;
        const match = h.match(/(\d{2})\/(\d{2})(?:,?\s*(\d{2}):(\d{2}))?/);
        if (match) {
            const year = new Date().getFullYear();
            const d = new Date(year, parseInt(match[2])-1, parseInt(match[1]),
                               parseInt(match[3]||0), parseInt(match[4]||0));
            return d;
        }
    }
    return new Date();
}

function snaphotEstado() {
    const now = new Date();
    const dataEvento = dataDoEvento();
    const dataStr = dataEvento.toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric'});
    const horaStr = now.toLocaleTimeString('pt-PT', {hour:'2-digit', minute:'2-digit'});
    const descricaoFinal = estado.descricaoEvento.trim() ||
        ('Sem Descrição · ' + dataStr + ' ' + horaStr);
    return {
        id: eventoAtualId || Date.now(),
        descricao: descricaoFinal,
        data: dataStr,
        ordens: JSON.parse(JSON.stringify(estado.ordens)),
        ofertas: JSON.parse(JSON.stringify(estado.ofertas)),
        totalFatura: estado.totalFatura,
        fatura: estado.fatura ? JSON.parse(JSON.stringify(estado.fatura)) : null,
        pagador: estado.pagador,
        dividas: JSON.parse(JSON.stringify(estado.dividas)),
        amigos: JSON.parse(JSON.stringify(amigos)),
        menu: JSON.parse(JSON.stringify(menu))
    };
}

function guardarEvento() {
    // Data is already auto-saved in historico. This button now exports JSON.
    if (historico.length === 0) { mostrarMensagem('⚠️ Sem eventos para exportar', false); return; }
    exportarJSON();
    mostrarMensagem('✓ JSON exportado', true);
}

function guardarEFechar() {
    // Legacy — no longer needed, but keep for compat
    guardarEvento();
}

function exportarJSON() {
    const exportData = { historico, pagamentos };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json;charset=utf-8'});
    const link = document.createElement('a');
    const ts = new Date().toISOString().slice(0,10);
    link.href = URL.createObjectURL(blob);
    link.download = 'DivisaoContasSa_historico_' + ts + '.json';
    link.click();
}

function importarJSON() {
    const input = document.getElementById('input-json');
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const text = e.target.result;
            const data = JSON.parse(text);
            // Support old format (array of events) and new format ({historico, pagamentos})
            if (Array.isArray(data)) {
                historico = data;
            } else if (data && Array.isArray(data.historico)) {
                historico = data.historico;
                if (Array.isArray(data.pagamentos)) {
                    pagamentos = data.pagamentos;
                    salvarPagamentos();
                }
            } else {
                mostrarMensagem('❌ Ficheiro inválido', false); return;
            }
            salvarHistoricoLocal();
            if (historico.length > 0) {
                const ultimo = historico[historico.length - 1];
                carregarEvento(ultimo);
            }
            atualizarReadOnly();
            renderHistoricoDropdown();
            renderConfigAmigos();
            renderConfigMenu();
            renderDropdownItens();
            renderAmigosBotoes();
            renderOfertaDropdowns();
            renderOfertaAmigos();
            renderPagadorSelect();
            atualizarUI();
            renderContas();
            mostrarMensagem('✓ ' + historico.length + ' evento(s) importado(s)', true);
        } catch(err) {
            console.error(err);
            mostrarMensagem('❌ Erro ao importar JSON: ' + err.message, false);
        }
        input.value = '';
    };
    reader.readAsText(file, 'UTF-8');
}


async function limparTudo() {
    const ok = await mostrarModal({
        icon: '🗑️',
        title: 'Limpar evento atual',
        msg: 'Isto remove todas as ordens e ofertas deste evento. Não pode ser desfeito!',
        confirmText: 'Limpar',
        cancelText: 'Cancelar',
        danger: true
    });
    if (ok) {
        modoReadOnly = false;
        estado.ordens = [];
        estado.ofertas = [];
        estado.totalFatura = null;
        estado.fatura = null;
        estado.descricaoEvento = '';
        estado.pagador = '';
        estado.dividas = {};
        document.getElementById('descricao-evento').value = '';
        document.getElementById('total-fatura').value = '';
        document.getElementById('pagador-select').value = '';
        document.getElementById('pagador-select').disabled = false;
        document.getElementById('ajuste-info').style.display = 'none';
        estado.amigosSelecionados.clear();
        estado.ofertaAmigos.clear();
        salvarNoLocalStorage();
        atualizarReadOnly();
        atualizarUI();
        renderConfigAmigos();
        renderConfigMenu();
        renderHistoricoDropdown();
        renderContas();
        mostrarMensagem('✓ Evento limpo', true);
    }
}

function mostrarMensagem(msg, sucesso) {
    const div = document.getElementById('mensagem');
    div.className = sucesso ? 'sucesso' : 'aviso';
    div.textContent = msg;
    // #mensagem fica perto do topo, mas há ações em blocos lá mais em baixo
    // (fatura, pagamentos, ofertas) — sem isto a mensagem aparecia e
    // desaparecia (3s) fora do ecrã, e parecia que a ação não tinha feito
    // nada. Só faz scroll se já não estiver visível, para não interromper
    // ações que acontecem perto do topo.
    const rect = div.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
        div.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => { div.textContent = ''; div.className = ''; }, 3000);
}

function pdfCabecalho(totalMesa, fatura, racio, diff, pct, sinal, corAjuste) {
    return `<div style="background:#0B3B2B;color:white;padding:22px 28px;border-radius:10px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
        <div>
            <div style="font-size:22px;font-weight:700;">🍽️ Divisão de Contas</div>
            ${estado.descricaoEvento ? `<div style="font-size:15px;font-weight:600;margin-top:6px;opacity:0.9;">${estado.descricaoEvento}</div>` : ''}
            <div style="font-size:13px;opacity:0.6;margin-top:4px;">${dataDoEvento().toLocaleDateString('pt-PT', {day:'2-digit',month:'long',year:'numeric'})}</div>
        </div>
        <div style="text-align:right;">
            <div style="font-size:11px;opacity:0.6;margin-bottom:2px;">Total calculado</div>
            <div style="font-size:24px;font-weight:800;color:#15915F;">€${totalMesa.toFixed(2)}</div>
            ${racio ? `<div style="font-size:11px;opacity:0.6;margin-top:8px;margin-bottom:2px;">Restaurante</div>
            <div style="font-size:20px;font-weight:800;color:#B8911F;">€${fatura.toFixed(2)}</div>
            <div style="font-size:14px;font-weight:700;color:${corAjuste};margin-top:3px;">${sinal}€${Math.abs(diff).toFixed(2)} (${sinal}${pct}%)</div>` : ''}
        </div>
    </div>`;
}

function abrirJanelaPDF(html, titulo) {
    const docHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${titulo}</title>
        <style>
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            @media print { body { margin: 0; } }
            body { margin: 0; background: white; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
            tr { page-break-inside: avoid; }
            table { border-collapse: collapse; }
        </style>
    </head><body>${html}</body></html>`;

    let ov = document.getElementById('pdfOverlay');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.id = 'pdfOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#525659;display:flex;flex-direction:column';
    ov.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#0B3B2B;color:#fff;flex:0 0 auto">
            <span style="font-weight:700;font-size:14px">${titulo}</span>
            <div style="display:flex;gap:8px">
                <button id="pdfPrint" style="background:#0E7A4F;border:none;color:#fff;font-size:14px;padding:8px 14px;border-radius:6px;cursor:pointer">🖨 Imprimir / Guardar PDF</button>
                <button id="pdfClose" style="background:rgba(255,255,255,.15);border:none;color:#fff;font-size:18px;padding:8px 14px;border-radius:6px;cursor:pointer">✕</button>
            </div>
        </div>
        <iframe id="pdfFrame" style="flex:1 1 auto;border:0;width:100%;background:#fff"></iframe>`;
    document.body.appendChild(ov);

    const frame = ov.querySelector('#pdfFrame');
    frame.srcdoc = docHtml;
    ov.querySelector('#pdfClose').onclick = () => ov.remove();
    ov.querySelector('#pdfPrint').onclick = () => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    };
}

// PDF Conta — ordens + total por item
function exportarPDFConta() {
    const totalMesa = estado.ordens.reduce((sum, o) => sum + o.precoTotal, 0);
    const fatura = estado.totalFatura;
    const racio = fatura ? fatura / totalMesa : null;
    const diff = fatura ? fatura - totalMesa : null;
    const pct = racio ? ((racio - 1) * 100).toFixed(1) : null;
    const sinal = (diff >= 0) ? '+' : '';
    const corAjuste = (diff >= 0) ? '#B3402F' : '#0E7A4F';

    const totalPorItem = {};
    const qtdPorItem = {};
    estado.ordens.forEach(o => {
        if (!totalPorItem[o.item]) { totalPorItem[o.item] = 0; qtdPorItem[o.item] = 0; }
        totalPorItem[o.item] += o.precoTotal;
        qtdPorItem[o.item] += o.quantidade;
    });
    const itens = Object.keys(totalPorItem).sort();

    const linhasOrdens = estado.ordens.length === 0
        ? '<tr><td colspan="5" style="text-align:center;color:#8A938D;padding:20px;">Nenhuma ordem registada.</td></tr>'
        : estado.ordens.map((o, i) => `
            <tr style="background:${i % 2 === 0 ? '#fff' : '#F7F8F4'}">
                <td style="padding:8px 10px;font-size:12px;color:#6B746F;">${o.hora ? o.hora.replace(', ', ' ') : '—'}</td>
                <td style="padding:8px 10px;font-weight:600;">${o.item}</td>
                <td style="padding:8px 10px;text-align:center;">${o.quantidade}x</td>
                <td style="padding:8px 10px;font-size:12px;color:#4A534E;">${o.amigos.join(', ')}</td>
                <td style="padding:8px 10px;text-align:right;font-weight:700;color:#0E7A4F;">€${o.precoTotal.toFixed(2)}</td>
            </tr>`).join('');

    const linhasItens = itens.map((item, i) => `
        <tr style="background:${i % 2 === 0 ? '#fff' : '#F7F8F4'}">
            <td style="padding:9px 14px;font-weight:600;">${item}</td>
            <td style="padding:9px 14px;text-align:center;color:#4A534E;">${qtdPorItem[item]}x</td>
            <td style="padding:9px 14px;text-align:right;font-weight:700;color:#0E7A4F;">€${totalPorItem[item].toFixed(2)}</td>
        </tr>`).join('');

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:30px;">
        ${pdfCabecalho(totalMesa, fatura, racio, diff, pct, sinal, corAjuste)}
        <div style="font-size:12px;font-weight:700;color:#0B3B2B;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">📋 Ordens</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);margin-bottom:24px;">
            <thead><tr style="background:#0E7A4F;color:white;">
                <th style="padding:9px 10px;text-align:left;">Hora</th>
                <th style="padding:9px 10px;text-align:left;">Item</th>
                <th style="padding:9px 10px;text-align:center;">Qtd</th>
                <th style="padding:9px 10px;text-align:left;">Quem</th>
                <th style="padding:9px 10px;text-align:right;">Total</th>
            </tr></thead>
            <tbody>${linhasOrdens}</tbody>
            <tfoot>
                <tr style="background:#EFF1EC;">
                    <td colspan="4" style="padding:10px;font-weight:700;">Total calculado</td>
                    <td style="padding:10px;text-align:right;font-weight:800;color:#0E7A4F;">€${totalMesa.toFixed(2)}</td>
                </tr>
                ${fatura ? `
                <tr style="background:#FFFDF6;">
                    <td colspan="4" style="padding:10px;font-weight:700;">Total restaurante</td>
                    <td style="padding:10px;text-align:right;font-weight:800;color:#B8911F;">€${fatura.toFixed(2)}</td>
                </tr>
                <tr style="background:${diff >= 0 ? '#F7E4E0' : '#E2EFE8'};">
                    <td colspan="4" style="padding:10px;font-weight:700;">Diferença</td>
                    <td style="padding:10px;text-align:right;font-weight:800;color:${diff >= 0 ? '#B3402F' : '#0E7A4F'};">${diff >= 0 ? '+' : ''}€${diff.toFixed(2)}</td>
                </tr>` : ''}
            </tfoot>
        </table>
        <div style="font-size:12px;font-weight:700;color:#0B3B2B;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">🧾 Total por item</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <thead><tr style="background:#0B3B2B;color:white;">
                <th style="padding:9px 14px;text-align:left;">Item</th>
                <th style="padding:9px 14px;text-align:center;">Qtd</th>
                <th style="padding:9px 14px;text-align:right;">Total</th>
            </tr></thead>
            <tbody>${linhasItens}</tbody>
        </table>
    </div>`;

    abrirJanelaPDF(html, 'conta_restaurante.pdf');
}

// PDF Divisão — conta por pessoa com consumo e ofertas
function exportarPDFDivisao() {
    const totalMesa = estado.ordens.reduce((sum, o) => sum + o.precoTotal, 0);
    const fatura = estado.totalFatura;
    const racio = fatura ? fatura / totalMesa : null;
    const diff = fatura ? fatura - totalMesa : null;
    const pct = racio ? ((racio - 1) * 100).toFixed(1) : null;
    const sinal = (diff >= 0) ? '+' : '';
    const corAjuste = (diff >= 0) ? '#B3402F' : '#0E7A4F';

    const setPessoas = new Set();
    estado.ordens.forEach(o => o.amigos.forEach(a => setPessoas.add(a)));
    const contaPorPessoa = {};
    setPessoas.forEach(p => contaPorPessoa[p] = 0);
    estado.ordens.forEach(o => {
        const share = o.precoTotal / o.amigos.length;
        o.amigos.forEach(a => contaPorPessoa[a] += share);
    });

    const saldoOfertas = calcularSaldoOfertas();
    const todasPessoas = new Set([...setPessoas]);
    estado.ofertas.forEach(o => { todasPessoas.add(o.quem); o.para.forEach(p => todasPessoas.add(p)); });
    const pessoasFinais = Array.from(todasPessoas).sort();
    const hasOfertas = estado.ofertas.length > 0;

    const linhasOfertas = estado.ofertas.length === 0 ? '' :
        estado.ofertas.map((o, i) => `
            <tr style="background:${i % 2 === 0 ? '#fff' : '#F7F8F4'}">
                <td style="padding:8px 10px;font-size:12px;color:#6B746F;">${o.hora || '—'}</td>
                <td style="padding:8px 10px;font-weight:600;color:#B8911F;">🎁 ${o.quem}</td>
                <td style="padding:8px 10px;">${o.quantidade}x ${o.item} → ${o.para.join(', ')}</td>
                <td style="padding:8px 10px;text-align:right;font-weight:700;color:#B8911F;">€${o.precoTotal.toFixed(2)}</td>
            </tr>`).join('');

    const cols = racio ? 4 : (hasOfertas ? 3 : 2);
    const cabPessoas = `<tr style="background:#0B3B2B;color:white;">
        <th style="padding:10px 14px;text-align:left;">Pessoa</th>
        <th style="padding:10px 14px;text-align:right;">Ordens</th>
        ${hasOfertas ? '<th style="padding:10px 14px;text-align:right;">Ofertas</th>' : ''}
        ${racio ? '<th style="padding:10px 14px;text-align:right;">Total final</th>' : (hasOfertas ? '<th style="padding:10px 14px;text-align:right;">Total após ofertas</th>' : '')}
    </tr>`;

    const linhasPessoas = pessoasFinais.length === 0
        ? `<tr><td colspan="${cols}" style="text-align:center;color:#8A938D;padding:20px;">Sem dados.</td></tr>`
        : pessoasFinais.map((p, i) => {
            const base = contaPorPessoa[p] || 0;
            const delta = saldoOfertas[p] || 0;
            const total = base + delta;
            const ajustado = racio ? total * racio : null;
            const deltaStr = delta !== 0 ? `<span style="color:#B8911F;font-size:12px;">${delta>0?'+':''}€${delta.toFixed(2)}</span>` : '<span style="color:#C8D0C8;">—</span>';
            const consumos = {};
            estado.ordens.forEach(o => {
                if (o.amigos.includes(p)) {
                    const share = o.quantidade / o.amigos.length;
                    consumos[o.item] = (consumos[o.item] || 0) + share;
                }
            });
            const consumoStr = Object.keys(consumos).sort().map(item => {
                const qtd = consumos[item];
                return `${Number.isInteger(qtd) ? qtd : qtd.toFixed(1)}× ${item}`;
            }).join(', ');
            return `<tr style="background:${i % 2 === 0 ? '#fff' : '#F7F8F4'}">
                <td style="padding:10px 14px;">
                    <div style="font-weight:600;font-size:14px;">${p}</div>
                    ${consumoStr ? `<div style="font-size:11px;color:#666;margin-top:3px;">${consumoStr}</div>` : ''}
                </td>
                <td style="padding:10px 14px;text-align:right;vertical-align:top;${(hasOfertas||racio)?'color:#9AA39D;font-size:13px;':'font-weight:800;color:#0E7A4F;font-size:15px;'}">€${base.toFixed(2)}</td>
                ${hasOfertas ? `<td style="padding:10px 14px;text-align:right;vertical-align:top;">${deltaStr}</td>` : ''}
                ${racio ? `<td style="padding:10px 14px;text-align:right;vertical-align:top;font-weight:800;font-size:15px;color:#B8911F;">€${ajustado.toFixed(2)}</td>` : (hasOfertas ? `<td style="padding:10px 14px;text-align:right;vertical-align:top;font-weight:800;color:#0E7A4F;font-size:15px;">€${total.toFixed(2)}</td>` : '')}
            </tr>`;
        }).join('');

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:30px;">
        ${pdfCabecalho(totalMesa, fatura, racio, diff, pct, sinal, corAjuste)}
        ${estado.ofertas.length > 0 ? `
        <div style="font-size:12px;font-weight:700;color:#0B3B2B;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">🎁 Ofertas</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);margin-bottom:24px;">
            <thead><tr style="background:#B8911F;color:white;">
                <th style="padding:9px 10px;text-align:left;">Hora</th>
                <th style="padding:9px 10px;text-align:left;">Quem</th>
                <th style="padding:9px 10px;text-align:left;">Oferta</th>
                <th style="padding:9px 10px;text-align:right;">Valor</th>
            </tr></thead>
            <tbody>${linhasOfertas}</tbody>
        </table>` : ''}
        <div style="font-size:12px;font-weight:700;color:#0B3B2B;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">💸 Conta por pessoa</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <thead>${cabPessoas}</thead>
            <tbody>${linhasPessoas}</tbody>
        </table>
    </div>`;

    abrirJanelaPDF(html, 'divisao_contas.pdf');
}

async function fecharComFatura() {
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para fechar este evento', false); return; }
    const fatura = parseFloat(document.getElementById('total-fatura').value);
    if (!fatura || fatura <= 0) { mostrarMensagem('⚠️ Introduz o valor da fatura', false); return; }
    const pagador = document.getElementById('pagador-select').value;
    if (!pagador) { mostrarMensagem('⚠️ Seleciona quem pagou a conta', false); return; }
    estado.totalFatura = fatura;
    estado.pagador = pagador;
    modoReadOnly = true;

    // Calcular dívidas com Hamilton (determinístico; sobra fica no pagador)
    const contaFinal = calcularContaFinalPorPessoa();
    const divisaoHamilton = calcularDivisaoHamilton(contaFinal, pagador);
    estado.dividas = {};
    Object.entries(divisaoHamilton).forEach(([pessoa, valor]) => {
        estado.dividas[pessoa] = { valor };
    });
    divisoes[eventoAtualId] = divisaoHamilton;

    // Adjust kept payments proportionally if fatura changed
    if (estado._manterPagamentos && estado._faturaAnterior && estado._faturaAnterior > 0) {
        const pgtosEvento = pagamentos.filter(p => p.eventoId === eventoAtualId);
        pgtosEvento.forEach(p => {
            const novaDivida = estado.dividas[p.pessoa];
            if (novaDivida) {
                p.valor = novaDivida.valor;
            }
        });
        salvarPagamentos();
    }
    delete estado._manterPagamentos;
    delete estado._faturaAnterior;

    document.getElementById('total-fatura').disabled = true;
    document.getElementById('pagador-select').disabled = true;
    document.getElementById('btn-fechar-evento').style.display = 'none';
    document.getElementById('btn-reabrir-evento').style.display = '';
    atualizarAjuste();
    salvarNoLocalStorage();
    atualizarReadOnly();
    renderContas();
    sbGuardarDivisao(eventoAtualId, divisaoHamilton);  // fire-and-forget, não bloqueia UI
    sbNotificarDividas(divisaoHamilton, estado.descricaoEvento);  // idem — notificação é um extra
    mostrarMensagem('✓ Conta fechada — €' + fatura.toFixed(2) + ' (paga por ' + pagador + ')', true);
}

// Calculate final amount per person considering ordens, ofertas, and fatura ratio
function calcularContaFinalPorPessoa() {
    const totalMesa = estado.ordens.reduce((sum, o) => sum + o.precoTotal, 0);
    const fatura = estado.totalFatura || totalMesa;
    const racio = totalMesa > 0 ? fatura / totalMesa : 1;

    const setPessoas = new Set();
    estado.ordens.forEach(o => o.amigos.forEach(a => setPessoas.add(a)));
    estado.ofertas.forEach(o => { setPessoas.add(o.quem); o.para.forEach(p => setPessoas.add(p)); });

    const contaBruta = {};
    setPessoas.forEach(p => contaBruta[p] = 0);
    estado.ordens.forEach(o => {
        const share = o.precoTotal / o.amigos.length;
        o.amigos.forEach(a => { contaBruta[a] = (contaBruta[a] || 0) + share; });
    });

    const saldoOfertas = calcularSaldoOfertas();
    const contaLiquida = {};
    setPessoas.forEach(p => {
        contaLiquida[p] = (contaBruta[p] || 0) + (saldoOfertas[p] || 0);
    });

    // Se fatura difere do total calculado, aplicar rácio proporcional
    const isMatch = Math.abs(fatura - totalMesa) < 0.01;
    if (isMatch || totalMesa === 0) return contaLiquida;

    const diff = fatura - totalMesa;
    const base = diff < 0 ? contaLiquida : contaBruta;
    const totalBase = Object.values(base).reduce((a, b) => a + b, 0);
    const contaFinal = {};
    setPessoas.forEach(p => {
        const part = totalBase > 0 ? (base[p] / totalBase) : 0;
        const ajuste = part * diff;
        contaFinal[p] = contaLiquida[p] + ajuste;
    });
    return contaFinal;
}

async function reabrirEvento() {
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para reabrir este evento', false); return; }
    const pgtosEvento = pagamentos.filter(p => p.eventoId === eventoAtualId);
    let manterPagamentos = false;

    if (pgtosEvento.length > 0 && ghHasToken()) {
        // Ask user whether to keep or delete existing payments
        const totalPgtos = pgtosEvento.reduce((s, p) => s + p.valor, 0);
        const ok = await mostrarModal({
            icon: '💰',
            title: 'Manter pagamentos?',
            msg: 'Este evento tem <strong>' + pgtosEvento.length + ' pagamento(s)</strong> registado(s) (total: €' + totalPgtos.toFixed(2) + ').<br><br>'
                + '🔄 <strong>Manter</strong> — os valores serão ajustados proporcionalmente se o total da conta mudar.<br>'
                + '🗑️ <strong>Eliminar</strong> — todos os pagamentos deste evento serão removidos.',
            confirmText: '🔄 Manter',
            cancelText: '🗑️ Eliminar',
            danger: false
        });
        manterPagamentos = ok;
    }

    modoReadOnly = false;

    if (!manterPagamentos) {
        pagamentos = pagamentos.filter(p => p.eventoId !== eventoAtualId);
        salvarPagamentos();
    }
    // Apagar divisão fixada — será recalculada no novo fecho
    delete divisoes[eventoAtualId];
    sbApagarDivisao(eventoAtualId);
    // Store old fatura value for proportional adjustment later
    estado._faturaAnterior = estado.totalFatura;
    estado.totalFatura = null;
    estado.pagador = '';
    estado.dividas = {};
    estado._manterPagamentos = manterPagamentos;
    document.getElementById('total-fatura').disabled = false;
    document.getElementById('pagador-select').disabled = false;
    document.getElementById('pagador-select').value = '';
    document.getElementById('btn-fechar-evento').style.display = '';
    document.getElementById('btn-reabrir-evento').style.display = 'none';
    document.getElementById('ajuste-info').style.display = 'none';
    salvarNoLocalStorage();
    atualizarReadOnly();
    atualizarUI();
    renderContas();
    mostrarMensagem(manterPagamentos ? '🔓 Evento reaberto (pagamentos mantidos)' : '🔓 Evento reaberto', true);
}

function confirmarFatura() { fecharComFatura(); }
function limparFatura() { reabrirEvento(); }

function atualizarAjuste() {
    const fatura = parseFloat(document.getElementById('total-fatura').value);
    const totalMesa = estado.ordens.reduce((sum, o) => sum + o.precoTotal, 0);
    const infoDiv = document.getElementById('ajuste-info');
    const racioDiv = document.getElementById('ajuste-racio');
    const ajusteDiv = document.getElementById('conta-pessoas-ajustada');

    if (!fatura || fatura <= 0 || totalMesa === 0) {
        infoDiv.style.display = 'none';
        return;
    }

    infoDiv.style.display = 'block';
    const diff = fatura - totalMesa;
    const isMatch = Math.abs(diff) < 0.01;

    if (isMatch) {
        // Fatura bate certo — visto verde, sem lista de ajustes
        racioDiv.innerHTML = '<span style="color:#0E7A4F;font-weight:600;">✅ Fatura confere com o total das ordens (€' + totalMesa.toFixed(2) + ')</span>';
        ajusteDiv.innerHTML = '';
        return;
    }

    // Fatura diferente — mostrar aviso e lista ajustada
    const racio = fatura / totalMesa;
    const pct = ((racio - 1) * 100).toFixed(1);
    const sinal = diff >= 0 ? '+' : '';
    const cor = diff >= 0 ? '#B3402F' : '#0E7A4F';
    racioDiv.innerHTML = '<span style="color:#A07712;font-weight:600;">⚠️ Diferença na fatura</span><br>' +
        'Fatura: <strong>€' + fatura.toFixed(2) + '</strong> · Calculado: <strong>€' + totalMesa.toFixed(2) + '</strong> · Ajuste: <strong style="color:' + cor + '">' + sinal + pct + '%</strong>';

    // Consumo bruto (antes de ofertas)
    const setPessoas = new Set();
    estado.ordens.forEach(o => o.amigos.forEach(a => setPessoas.add(a)));
    const consumoBruto = {};
    setPessoas.forEach(p => consumoBruto[p] = 0);
    estado.ordens.forEach(ordem => {
        const share = ordem.precoTotal / ordem.amigos.length;
        ordem.amigos.forEach(a => consumoBruto[a] += share);
    });

    // Consumo líquido (após ofertas)
    const saldoOfertas = calcularSaldoOfertas();
    const consumoLiquido = {};
    setPessoas.forEach(p => consumoLiquido[p] = consumoBruto[p] + (saldoOfertas[p] || 0));

    // Ajuste proporcional
    let base = consumoBruto;
    if (diff < 0) base = consumoLiquido;
    const totalBase = Object.values(base).reduce((a, b) => a + b, 0);
    const pessoas = Array.from(setPessoas).sort();
    ajusteDiv.innerHTML = pessoas.map(p => {
        const original = consumoLiquido[p];
        const part = totalBase > 0 ? (base[p] / totalBase) : 0;
        const ajuste = part * diff;
        const ajustado = original + ajuste;
        return `
        <div class="pessoa-ajuste">
            <span class="pessoa-nome">${p}</span>
            <span class="valor-original">€${original.toFixed(2)}</span>
            <span class="valor-ajustado">€${ajustado.toFixed(2)}</span>
        </div>
        `;
    }).join('');
}



function toggleSection(name) {
    const sec = document.getElementById('section-' + name);
    if (!sec || sec.classList.contains('no-toggle')) return;
    sec.classList.toggle('collapsed');
}

function aplicarColapsosSecoes() {
    // 1. Adicionar Ordem — colapsado e sem opção de expandir em evento fechado;
    //    expandido e expansível ao desbloquear.
    const secAdd = document.getElementById('section-adicionar');
    if (secAdd) {
        if (modoReadOnly) {
            secAdd.classList.add('collapsed', 'no-toggle');
        } else {
            secAdd.classList.remove('collapsed', 'no-toggle');
        }
    }
    // 2b. Ofertas — sempre expansível; colapsado por defeito quando não há ofertas
    //    (eventos novos ou fechados sem ofertas), expandido quando existe oferta.
    const secOf = document.getElementById('section-ofertas');
    if (secOf) {
        secOf.classList.remove('no-toggle');
        const temOfertas = estado.ofertas && estado.ofertas.length > 0;
        secOf.classList.toggle('collapsed', !temOfertas);
    }
}

/* ── IMPORTAR FATURA (foto/PDF → Gemini → conferência artigo a artigo) ──────
   Até aqui a fatura era só um número: metia-se o total e a app espalhava a
   diferença por toda a gente com um rácio. Com a foto do talão passa a haver
   detalhe: a Edge Function `fatura-restaurante` (mesmo projeto Supabase da
   FestasBV, prompt próprio para conta de restaurante) devolve
   {restaurante, data, total, linhas:[{artigo,qtd,precoUnit,precoTotal}]} e a app
   compara linha a linha com o que foi marcado como consumido.

   O caso que interessa mesmo: quando os artigos e as QUANTIDADES batem certo e
   só os PREÇOS divergem (a casa subiu a imperial e o menu da app ficou velho),
   não há nada para discutir sobre quem comeu o quê — é só corrigir o preço do
   artigo NESTE evento. Aí a divisão passa a ser exata, sem rácio nenhum.
   O utilizador revê sempre antes de aplicar seja o que for. */

/* A fatura lida fica GUARDADA no evento (`estado.fatura`), não só em memória:
   é o registo do que a casa cobrou, e é o que permite reabrir a conferência
   meses depois sem ter de fotografar outra vez. O painel aberto/fechado é que
   é volátil — isso é só ecrã. */
let _faturaPainel = false;  // detalhe expandido? (UI, não se guarda)
let _faturaRows = [];       // linhas da conferência, recalculadas a cada render

const _frR2 = v => Math.round(v * 100) / 100;
function _frEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
// Nome vindo da leitura, pronto a meter dentro de onchange="fn('...')": escapa
// para literal JS de aspa simples primeiro, depois para atributo HTML.
function _frJsArg(s) {
    return _frEsc(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}
// Chave de comparação: minúsculas, sem acentos, sem pontuação
function faturaKey(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}
function faturaTokens(s) { return faturaKey(s).split(' ').filter(t => t.length >= 3); }
// Duas palavras são "a mesma" se partilharem um prefixo longo. Prefixo em vez de
// igualdade porque o talão vem quase sempre no plural e o menu no singular — e
// prefixo COMPRIDO (não startsWith) porque em português o plural nem sempre
// acrescenta letras: imperial→imperiais, pastel→pastéis. Mínimo de 4 letras
// iguais para "sumo"/"sopa" não colarem uma na outra.
function _frTokSim(a, b) {
    if (a === b) return 1;
    let i = 0; const n = Math.min(a.length, b.length);
    while (i < n && a[i] === b[i]) i++;
    return i >= 4 ? i / Math.max(a.length, b.length) : 0;
}
// Score 0..1 entre dois nomes. As duas direções contam, mas a melhor pesa mais:
// o talão costuma ser mais falado que o menu ("Bitoque" vs "Bitoque de vaca") e
// exigir cobertura total nos dois sentidos deixava esses de fora.
function faturaScore(a, b) {
    const ta = faturaTokens(a), tb = faturaTokens(b);
    if (!ta.length || !tb.length) { const ka = faturaKey(a); return ka && ka === faturaKey(b) ? 1 : 0; }
    const hit = (x, y) => x.filter(t => y.some(u => _frTokSim(t, u) >= 0.7)).length;
    const d1 = hit(ta, tb) / ta.length, d2 = hit(tb, ta) / tb.length;
    return Math.max(d1, d2) * 0.6 + Math.min(d1, d2) * 0.4;
}

function faturaPick() {
    if (!eventoAtualId) { mostrarMensagem('⚠️ Cria ou abre um evento primeiro', false); return; }
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para editar este evento', false); return; }
    // Conta fechada não bloqueia a LEITURA — só as correções que mexem em ordens
    // (faturaMarcarExtra/faturaUsarTotal continuam a recusar-se em modoReadOnly;
    // faturaCorrigirPrecoItem em conta fechada só deixa corrigir no menu). É o
    // caso de quem fechou a conta pelo total antes de a leitura por foto
    // funcionar e agora só quer ver o detalhe artigo a artigo, sem mexer em nada
    // do que já foi pago.
    if (!_sbSession) { mostrarMensagem('⚠️ Inicia sessão para usar a leitura da fatura', false); return; }
    const i = document.getElementById('fatura-file');
    if (i) i.click();
}

async function faturaChosen(inp) {
    const f = inp.files && inp.files[0];
    inp.value = '';
    if (!f) return;
    const btn = document.getElementById('btn-fatura-ocr');
    const label = btn ? btn.innerHTML : '';   // duas linhas (título + subtítulo) → repor em HTML
    if (btn) { btn.disabled = true; btn.textContent = '⏳ A ler a fatura…'; }
    try {
        // PDF vai tal e qual (o Gemini lê PDFs nativamente); imagem é comprimida em canvas
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
        if (isPdf && f.size > 4 * 1024 * 1024) throw new Error('PDF demasiado grande (máx. 4 MB)');
        const { b64, mime } = isPdf ? await faturaLerPdf(f) : await faturaComprime(f);
        // O menu do evento segue no pedido: com ele o modelo devolve o nome que a
        // app já usa em vez de uma grafia nova, e a conferência bate certo
        const body = { image: b64, mime };
        const arts = Object.keys(menu).slice(0, 200).map(n => ({ nome: n, preco: menu[n] }));
        if (arts.length) body.menu = arts;
        // Rede de segurança própria: a Edge Function tem um limite interno de 50s,
        // mas se o pedido nem lá chegar a responder (rede caída, função presa),
        // sem isto o botão ficava a "pensar" para sempre. 65s dá margem ao limite
        // interno mais o tempo de rede.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 65000);
        let r;
        try {
            r = await sbFetch(`${SB_URL}/functions/v1/fatura-restaurante`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
        } finally { clearTimeout(timer); }
        if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            if (r.status === 404) throw new Error('a função de leitura ainda não está publicada no Supabase');
            throw new Error(e.error || ('HTTP ' + r.status));
        }
        faturaAplicar(await r.json());
    } catch (e) {
        // "Load failed"/"Failed to fetch" é o erro genérico do browser quando o
        // pedido é cortado por timeout (~60s no iOS) ou a ligação cai a meio;
        // AbortError é o nosso próprio timeout (65s no pedido, 15s na leitura
        // da imagem/PDF) a disparar. Distinguir os dois no texto — um é
        // "demorou mesmo muito", o outro é falha instantânea de rede/CORS —
        // é o que falta para apanhar a causa real em vez de andar a adivinhar.
        const m = String(e && e.message || e);
        const nome = e && e.name ? e.name : '';
        const rede = /load failed|failed to fetch|networkerror|timed? ?out/i.test(m) || nome === 'AbortError';
        mostrarMensagem(rede
            ? `❌ A leitura demorou demasiado ou falhou a ligação [${nome || 'erro'}: ${m.slice(0, 80)}]. Tenta uma foto mais nítida ou volta a tentar.`
            : '❌ Não consegui ler a fatura: ' + m, false);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
}

// Lê um PDF em base64, sem transformação (o modelo aceita PDFs diretamente)
function faturaLerPdf(file) {
    return new Promise((resolve, reject) => {
        let feito = false;
        const done = (fn, arg) => { if (!feito) { feito = true; clearTimeout(limite); fn(arg); } };
        const limite = setTimeout(() => done(reject, new Error('demorei demasiado a ler o PDF')), 15000);
        const rd = new FileReader();
        rd.onload = () => done(resolve, { b64: String(rd.result).split(',')[1], mime: 'application/pdf' });
        rd.onerror = () => done(reject, new Error('não consegui ler o PDF'));
        rd.readAsDataURL(file);
    });
}
// Reduz a foto (máx 1600px no lado maior, JPEG q0.85): chega de sobra para o
// modelo ler o talão e mantém o upload leve mesmo em rede móvel
function faturaComprime(file) {
    return new Promise((resolve, reject) => {
        // Alguns formatos que o telemóvel entrega (ex.: HEIC mal suportado)
        // não disparam onload NEM onerror em certos browsers — sem este
        // limite, a conversão ficava presa antes de sequer chegar à rede.
        let feito = false;
        const done = (fn, arg) => { if (!feito) { feito = true; clearTimeout(limite); fn(arg); } };
        const limite = setTimeout(() => done(reject, new Error('demorei demasiado a processar a imagem')), 15000);
        const img = new Image();
        img.onload = () => {
            const MAX = 1600;
            const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(img.src);
            done(resolve, { b64: cv.toDataURL('image/jpeg', 0.85).split(',')[1], mime: 'image/jpeg' });
        };
        img.onerror = () => { URL.revokeObjectURL(img.src); done(reject, new Error('imagem inválida')); };
        img.src = URL.createObjectURL(file);
    });
}

// Resposta do modelo → estado da conferência (guarda-se o que foi LIDO, cru; as
// comparações são refeitas a cada render para acompanharem edições às ordens)
function faturaAplicar(d) {
    const cru = (d && Array.isArray(d.linhas)) ? d.linhas : [];
    const linhas = [];
    let semPreco = 0;
    cru.forEach(l => {
        const nome = String((l && l.artigo) || '').replace(/\s+/g, ' ').trim();
        if (!nome) return;
        let q = Number(l.qtd);
        if (!isFinite(q) || q <= 0) q = 1;
        let u = Number(l.precoUnit), t = Number(l.precoTotal);
        if (!isFinite(u) || u < 0) u = NaN;
        if (!isFinite(t) || t < 0) t = NaN;
        if (isNaN(u) && !isNaN(t)) u = t / q;
        if (isNaN(t) && !isNaN(u)) t = u * q;
        if (isNaN(u)) { semPreco++; return; }   // linha sem preço legível não dá para conferir
        linhas.push({ nome, qtd: q, unit: _frR2(u), total: _frR2(t) });
    });
    if (!linhas.length) { mostrarMensagem('❌ Não encontrei artigos legíveis na fatura', false); return; }
    const total = (d && isFinite(Number(d.total)) && Number(d.total) > 0) ? _frR2(Number(d.total)) : null;
    estado.fatura = {
        restaurante: String((d && d.restaurante) || '').slice(0, 80),
        data: String((d && d.data) || '').slice(0, 10),
        total, linhas, semPreco,
        lidaEm: new Date().toISOString()
    };
    _faturaPainel = true;
    salvarNoLocalStorage();
    faturaRenderRecon();
    const box = document.getElementById('fatura-recon');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Apagar a fatura guardada. Não mexe nas ordens nem nos preços já corrigidos —
// o que foi aplicado foi aplicado; isto só deita fora o registo da leitura.
async function faturaApagar() {
    if (!estado.fatura) return;
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para editar este evento', false); return; }
    const ok = await mostrarModal({
        icon: '🗑️',
        title: 'Apagar a fatura guardada?',
        msg: 'Remove o detalhe lido da fatura deste evento (' + estado.fatura.linhas.length + ' linha(s)).<br><br>'
            + 'As ordens e os preços já corrigidos <strong>não</strong> são alterados.',
        confirmText: 'Apagar',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    estado.fatura = null;
    _faturaPainel = false;
    salvarNoLocalStorage();
    faturaRenderRecon();
    mostrarMensagem('✓ Fatura apagada', true);
}

/* Compara a fatura lida com o consumo marcado. Devolve uma linha por artigo:
     ok     — quantidade e preço batem certo
     preco  — quantidade certa, preço diferente  (é o caso que se pode corrigir)
     qtd    — quantidade diferente
     extra  — está na fatura mas não foi marcado por ninguém
     falta  — foi marcado mas não aparece na fatura                              */
function faturaConferir() {
    const r = estado.fatura;
    if (!r) return null;

    // Consumo marcado, agregado por artigo
    const cons = {};
    estado.ordens.forEach(o => {
        const c = cons[o.item] || (cons[o.item] = { item: o.item, qtd: 0, total: 0 });
        c.qtd += o.quantidade;
        c.total += o.precoTotal;
    });
    Object.keys(cons).forEach(k => { cons[k].unit = cons[k].qtd ? _frR2(cons[k].total / cons[k].qtd) : 0; });
    const porChave = {};
    Object.keys(menu).forEach(k => { porChave[faturaKey(k)] = k; });
    Object.keys(cons).forEach(k => { porChave[faturaKey(k)] = k; });   // consumido manda sobre o menu

    // Fatura agregada pelo artigo a que cada linha corresponde (a mesma bebida
    // pode vir em duas linhas da conta)
    const fat = {};
    r.linhas.forEach(l => {
        // Reatribuição manual (faturaReatribuirLinha) manda sobre o emparelhamento
        // automático — é o que corrige casos como "Caneca Stout" a ser apanhada
        // por engano para dentro de "Caneca" só por partilharem a palavra.
        const ov = r.overrides && r.overrides[faturaKey(l.nome)];
        let item;
        if (ov !== undefined) {
            item = ov || null;   // override '' = item à parte, propositadamente sem par
        } else {
            item = porChave[faturaKey(l.nome)] || null;
            if (!item) {
                // Sem nome igual: escolhe o mais parecido, primeiro entre o que foi
                // consumido e só depois no resto do menu
                let best = null, bs = 0;
                Object.keys(cons).forEach(it => { const s = faturaScore(it, l.nome); if (s > bs) { bs = s; best = it; } });
                if (bs < 0.6) Object.keys(menu).forEach(it => { const s = faturaScore(it, l.nome); if (s > bs) { bs = s; best = it; } });
                if (bs >= 0.6) item = best;
            }
        }
        const key = item || ('~' + faturaKey(l.nome));
        const f = fat[key] || (fat[key] = { item, nome: item || l.nome, qtd: 0, total: 0, nomes: [] });
        f.qtd += l.qtd;
        f.total = _frR2(f.total + l.total);
        if (f.nomes.indexOf(l.nome) < 0) f.nomes.push(l.nome);
    });

    const rows = [];
    Object.keys(fat).forEach(key => {
        const f = fat[key];
        f.unit = f.qtd ? _frR2(f.total / f.qtd) : 0;
        const c = f.item ? cons[f.item] : null;
        if (!c) {
            // Na fatura mas ninguém marcou (artigo novo ou esquecido)
            rows.push({ tipo: 'extra', item: f.item, nome: f.nome, nomesFatura: f.nomes,
                        qtdF: f.qtd, unitF: f.unit, totF: f.total });
            return;
        }
        const dq = _frR2(f.qtd - c.qtd);
        const du = _frR2(f.unit - c.unit);
        rows.push({
            tipo: Math.abs(dq) > 0.001 ? 'qtd' : (Math.abs(du) >= 0.01 ? 'preco' : 'ok'),
            item: f.item, nome: f.item, nomesFatura: f.nomes,
            qtdF: f.qtd, qtdC: c.qtd, unitF: f.unit, unitC: c.unit,
            totF: f.total, totC: _frR2(c.total), dq, du
        });
    });
    // Marcado mas ausente da fatura
    const naFatura = {};
    Object.keys(fat).forEach(k => { if (fat[k].item) naFatura[fat[k].item] = true; });
    Object.keys(cons).forEach(it => {
        if (naFatura[it]) return;
        rows.push({ tipo: 'falta', item: it, nome: it, qtdC: cons[it].qtd, unitC: cons[it].unit, totC: _frR2(cons[it].total) });
    });

    // Problemas primeiro, depois preços, e o que está certo por último
    const rank = { qtd: 0, extra: 1, falta: 2, preco: 3, ok: 4 };
    rows.sort((a, b) => (rank[a.tipo] - rank[b.tipo]) || a.nome.localeCompare(b.nome, 'pt'));

    const n = t => rows.filter(x => x.tipo === t).length;
    const precoRows = rows.filter(x => x.tipo === 'preco');
    return {
        rows,
        nOk: n('ok'), nPreco: n('preco'), nQtd: n('qtd'), nExtra: n('extra'), nFalta: n('falta'),
        contagemOk: !n('qtd') && !n('extra') && !n('falta'),
        difPrecos: _frR2(precoRows.reduce((s, x) => s + (x.totF - x.totC), 0)),
        totalMesa: _frR2(estado.ordens.reduce((s, o) => s + o.precoTotal, 0)),
        totalLinhas: _frR2(rows.reduce((s, x) => s + (x.totF || 0), 0))
    };
}

function faturaRenderRecon() {
    const box = document.getElementById('fatura-recon');
    if (!box) return;
    const btnImp = document.getElementById('btn-fatura-ocr');
    const r = estado.fatura, c = faturaConferir();
    if (!r || !c) {
        box.style.display = 'none'; box.innerHTML = ''; _faturaRows = [];
        if (btnImp) btnImp.innerHTML = '📷 Importar fatura (foto ou PDF)<span>compara artigo a artigo com o consumo marcado</span>';
        return;
    }
    _faturaRows = c.rows;
    const podeMexer = !modoReadOnly && podeEditarEventoAtual();
    // Corrigir preço (🔄 por linha) e reatribuir o emparelhamento continuam
    // disponíveis com a conta fechada — cada um decide por si como aplicar
    // sem mexer em ordens/total já fechados (faturaCorrigirPrecoItem trata
    // disso com o popup; a reatribuição nem sequer toca em preços/ordens).
    const podeReatribuir = podeEditarEventoAtual();
    // Já há fatura guardada: importar outra é substituí-la, e o botão diz isso
    if (btnImp) btnImp.innerHTML = '🔄 Ler outra fatura<span>substitui a que está guardada neste evento</span>';

    // Reservas: o que a leitura não garante, mesmo quando as linhas batem certo.
    // Sem isto o veredicto dizia "confere" com linhas por ler em cima da mesa.
    const difTotal = r.total != null ? _frR2(r.total - c.totalLinhas) : 0;
    const reservas = [];
    if (r.semPreco) reservas.push(r.semPreco + (r.semPreco === 1 ? ' linha da fatura ficou' : ' linhas da fatura ficaram') + ' por ler (preço ilegível)');
    if (Math.abs(difTotal) >= 0.01) {
        reservas.push('o total impresso (€' + r.total.toFixed(2) + ') não é a soma das linhas (€'
            + c.totalLinhas.toFixed(2) + ')' + (difTotal > 0 ? ' — serviço, couvert ou linha em falta?' : ''));
    }

    // Veredicto — a frase que se lê primeiro
    let vClasse, vTitulo, vTexto;
    if (c.contagemOk && !c.nPreco && !reservas.length) {
        vClasse = 'ok';
        vTitulo = '✅ A fatura confere';
        vTexto = 'Artigos, quantidades e preços batem certo com o que foi marcado.';
    } else if (c.contagemOk && !c.nPreco) {
        vClasse = 'preco';
        vTitulo = '✅ Artigos e preços batem certo';
        vTexto = 'Mas confere o total antes de fechar.';
    } else if (c.contagemOk) {
        const sinal = c.difPrecos >= 0 ? '+' : '−';
        vClasse = 'preco';
        vTitulo = '💶 Contagem certa — só os preços divergem';
        vTexto = 'Os artigos e as quantidades batem todos certo. ' + c.nPreco
            + (c.nPreco === 1 ? ' artigo tem' : ' artigos têm') + ' preço diferente na fatura ('
            + sinal + '€' + Math.abs(c.difPrecos).toFixed(2) + '). Corrige os preços neste evento e a divisão fica exata, sem rácio.';
    } else {
        const faltas = [];
        if (c.nQtd) faltas.push(c.nQtd + ' com quantidade diferente');
        if (c.nExtra) faltas.push(c.nExtra + ' na fatura sem estar marcado');
        if (c.nFalta) faltas.push(c.nFalta + ' marcado sem estar na fatura');
        vClasse = 'qtd';
        vTitulo = '⚠️ Diferenças na contagem';
        vTexto = 'Confere estes artigos antes de fechar: ' + faltas.join(' · ') + '.';
    }
    if (reservas.length) {
        const t = reservas.join('; ');
        vTexto += ' Atenção: ' + t + (/[?.!]$/.test(t) ? '' : '.');
    }

    // Cabeçalho lido do talão + totais
    const meta = [];
    if (r.restaurante) meta.push('🏠 ' + _frEsc(r.restaurante));
    if (r.data) meta.push('📅 ' + _frEsc(r.data));
    meta.push('🧾 Soma das linhas: €' + c.totalLinhas.toFixed(2));
    if (r.total != null) {
        meta.push('Total impresso: €' + r.total.toFixed(2)
            + (Math.abs(difTotal) >= 0.01 ? ' <span class="neg">(' + (difTotal > 0 ? '+' : '−') + '€' + Math.abs(difTotal).toFixed(2) + ')</span>' : ''));
    }
    meta.push('Marcado na app: €' + c.totalMesa.toFixed(2));

    const tag = { ok: 'certo', preco: 'preço', qtd: 'quantidade', extra: 'não marcado', falta: 'sem fatura' };
    const linhasHtml = c.rows.map((x, i) => {
        let det = '', chk = '<span class="fr-chk-off"></span>', acao = '';
        if (x.tipo === 'ok') {
            det = x.qtdF + ' × €' + x.unitF.toFixed(2) + ' = €' + x.totF.toFixed(2);
        } else if (x.tipo === 'preco') {
            const cl = x.du > 0 ? 'neg' : 'pos';
            det = x.qtdF + ' un · marcado €' + x.unitC.toFixed(2) + ' → fatura €' + x.unitF.toFixed(2)
                + ' <span class="' + cl + '">(' + (x.du > 0 ? '+' : '−') + '€' + Math.abs(_frR2(x.totF - x.totC)).toFixed(2) + ')</span>';
            if (podeReatribuir) acao = '<button class="fr-acao" onclick="faturaCorrigirPrecoItem(' + i + ')" title="Corrigir preço">🔄</button>';
        } else if (x.tipo === 'qtd') {
            const cl = x.dq > 0 ? 'neg' : 'pos';
            det = 'marcado ' + x.qtdC + ' × €' + x.unitC.toFixed(2) + ' · fatura ' + x.qtdF + ' × €' + x.unitF.toFixed(2)
                + ' <span class="' + cl + '">(' + (x.dq > 0 ? '+' : '−') + Math.abs(x.dq) + ' un)</span>';
        } else if (x.tipo === 'extra') {
            det = 'fatura: ' + x.qtdF + ' × €' + x.unitF.toFixed(2) + ' = €' + x.totF.toFixed(2) + ' · ninguém marcou este artigo';
            if (podeMexer) acao = '<button class="fr-acao" onclick="faturaMarcarExtra(' + i + ')">➕ Marcar</button>';
        } else {
            det = 'marcado: ' + x.qtdC + ' × €' + x.unitC.toFixed(2) + ' = €' + x.totC.toFixed(2) + ' · não aparece na fatura';
        }
        // Nome(s) que vieram impressos, quando diferem do artigo da app. Com
        // permissão, cada um vira um <select> — é o que deixa desfazer um
        // emparelhamento errado (ex.: "Caneca Stout" apanhado para "Caneca").
        const alias = (x.nomesFatura || []).filter(n => faturaKey(n) !== faturaKey(x.nome));
        let sub = '';
        if (alias.length) {
            sub = podeReatribuir
                ? '<div class="fr-det fr-reatr-lista">na fatura: ' + alias.map(n =>
                    '<span class="fr-reatr-item">' + _frEsc(n) + ' ' + faturaOpcoesReatribuir(n) + '</span>').join(' · ') + '</div>'
                : '<div class="fr-det">na fatura: ' + _frEsc(alias.join(', ')) + '</div>';
        }
        return '<div class="fr-linha">' + chk
            + '<div class="fr-body"><div class="fr-nome">' + _frEsc(x.nome)
            + '<span class="fr-tag ' + x.tipo + '">' + tag[x.tipo] + '</span></div>'
            + '<div class="fr-det">' + det + '</div>' + sub + '</div>' + acao + '</div>';
    }).join('');

    // Com a conta fechada (ou sem permissão) a fatura vê-se na mesma — é para
    // isso que fica guardada — mas sem botões que só iam recusar-se a agir.
    // Correções de preço já não vivem aqui: são o 🔄 por linha (faturaCorrigirPrecoItem).
    const btns = [];
    if (podeMexer) {
        if (r.total != null) btns.push('<button class="fr-sec" onclick="faturaUsarTotal()">🧾 Usar total €' + r.total.toFixed(2) + '</button>');
        btns.push('<button class="fr-sec" onclick="faturaApagar()">🗑️ Apagar fatura</button>');
    }

    // Barra de resumo — fica sempre visível quando o evento tem fatura guardada.
    // É por aqui que se reabre o detalhe meses depois, sem refotografar nada.
    const quando = _frDataCurta(r.lidaEm);
    const resumo = [r.restaurante ? _frEsc(r.restaurante) : 'Fatura',
                    r.linhas.length + (r.linhas.length === 1 ? ' linha' : ' linhas'),
                    '€' + (r.total != null ? r.total : c.totalLinhas).toFixed(2)].join(' · ');
    const strip = '<button class="fr-strip ' + vClasse + '" onclick="faturaTogglePainel()">'
        + '<span class="fr-strip-ic">🧾</span>'
        + '<span class="fr-strip-txt"><b>' + resumo + '</b>'
        + '<span>' + _frEsc(vTitulo) + (quando ? ' · lida a ' + quando : '') + '</span></span>'
        + '<span class="fr-strip-chev">' + (_faturaPainel ? '▲' : '▼') + '</span></button>';

    box.innerHTML = strip + (!_faturaPainel ? '' :
          '<div class="fr-verdict ' + vClasse + '"><b>' + vTitulo + '</b>' + vTexto + '</div>'
        + '<div class="fr-meta">' + meta.join(' · ')
        + (r.semPreco ? ' · <span class="neg">' + r.semPreco + (r.semPreco === 1 ? ' linha ignorada' : ' linhas ignoradas') + ' (sem preço)</span>' : '') + '</div>'
        + linhasHtml
        + '<div class="fr-btns">' + btns.join('') + '</div>');
    box.style.display = '';
}

// "12/03, 21:40" a partir do ISO guardado; vazio se não der para ler
function _frDataCurta(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Emparelhamento automático (faturaKey + faturaScore) por vezes junta linhas
// que não são o mesmo artigo — ex.: "Caneca Stout" cai para dentro de "Caneca"
// só por partilharem a palavra. Isto deixa corrigir à mão, por LINHA lida (não
// por artigo da app): "automático" volta ao critério normal, "item à parte"
// força a linha a nunca se juntar a nada, ou escolhe-se outro artigo do menu.
// Guarda-se em estado.fatura.overrides (chave = faturaKey do nome lido) — fica
// preso a ESTA leitura; importar outra fatura de raiz começa sem overrides.
function faturaReatribuirLinha(nomeOriginal, valor) {
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para editar este evento', false); return; }
    if (!estado.fatura) return;
    const key = faturaKey(nomeOriginal);
    if (!estado.fatura.overrides) estado.fatura.overrides = {};
    if (valor === '__auto') delete estado.fatura.overrides[key];
    else if (valor === '__none') estado.fatura.overrides[key] = '';
    else estado.fatura.overrides[key] = valor;
    salvarNoLocalStorage();
    faturaRenderRecon();
}

// <select> com as opções de reatribuição para uma linha lida em concreto.
function faturaOpcoesReatribuir(nomeOriginal) {
    const key = faturaKey(nomeOriginal);
    const overrides = estado.fatura && estado.fatura.overrides;
    const temOverride = overrides && Object.prototype.hasOwnProperty.call(overrides, key);
    const atual = temOverride ? (overrides[key] || '__none') : '__auto';
    const itens = Object.keys(menu).sort((a, b) => a.localeCompare(b, 'pt'));
    const opts = ['<option value="__auto"' + (atual === '__auto' ? ' selected' : '') + '>— automático —</option>',
                  '<option value="__none"' + (atual === '__none' ? ' selected' : '') + '>é um item à parte</option>']
        .concat(itens.map(it => '<option value="' + _frEsc(it) + '"' + (atual === it ? ' selected' : '') + '>' + _frEsc(it) + '</option>'));
    return '<select class="fr-reatribuir" onchange="faturaReatribuirLinha(\'' + _frJsArg(nomeOriginal) + '\', this.value)">'
        + opts.join('') + '</select>';
}

// Botão 🔄 de uma linha com preço diferente: popup a perguntar ONDE corrigir.
// "Neste evento" só se oferece com a conta aberta (atualiza ordens + total já
// lançados); "Só no menu" fica sempre disponível e nunca mexe em ordens nem
// no total — é só o preço de referência para a próxima vez que abrires o
// artigo. Em conta fechada a única opção sensata é logo essa.
async function faturaCorrigirPrecoItem(i) {
    const x = _faturaRows[i];
    if (!x || x.tipo !== 'preco' || !x.item) return;
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para editar este evento', false); return; }
    const podeNesteEvento = !modoReadOnly;
    const msg = 'A fatura mostra <b>' + _frEsc(x.item) + '</b> a €' + x.unitF.toFixed(2)
        + ', mas está marcado a €' + x.unitC.toFixed(2) + '.<br><br>'
        + (podeNesteEvento
            ? 'Corrigir <b>neste evento</b> atualiza as ordens já lançadas e o total. Corrigir <b>só no menu</b> fica como referência para a próxima vez, sem mexer no que já está marcado aqui.'
            : 'A conta está fechada — só dá para atualizar o preço de referência no menu, para a próxima vez. As ordens e o total já fechado não são tocados.');
    const res = await mostrarModal({
        icon: '💶',
        title: 'Corrigir preço — ' + x.item,
        msg,
        cancelText: 'Cancelar',
        extraText: podeNesteEvento ? 'Só no menu' : undefined,
        confirmText: podeNesteEvento ? 'Neste evento' : 'Corrigir no menu'
    });
    if (res === false) return;
    const soMenu = res === 'extra' || !podeNesteEvento;
    menu[x.item] = x.unitF;
    if (!soMenu) {
        estado.ordens.forEach(o => {
            if (o.item !== x.item) return;
            o.precoUnitario = x.unitF;
            o.precoTotal = _frR2(x.unitF * o.quantidade);
        });
    }
    salvarNoLocalStorage();
    renderDropdownItens();
    renderConfigMenu();
    if (!soMenu) {
        atualizarUI();   // refaz também a conferência com o preço novo
        atualizarPreco();
        if (document.getElementById('total-fatura').value) atualizarAjuste();
    } else {
        faturaRenderRecon();
    }
    mostrarMensagem(soMenu
        ? '✓ Preço de "' + x.item + '" atualizado no menu — as ordens e o total não foram tocados'
        : '✓ Preço de "' + x.item + '" corrigido neste evento', true);
}

// Artigo que está na fatura mas ninguém marcou: acrescenta-o ao menu com o preço
// da fatura e deixa o formulário pronto — só falta escolher quem consumiu.
function faturaMarcarExtra(i) {
    const x = _faturaRows[i];
    if (!x || x.tipo !== 'extra') return;
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para editar este evento', false); return; }
    if (modoReadOnly) { mostrarMensagem('⚠️ Conta fechada — reabre-a primeiro', false); return; }
    if (menu[x.nome] == null || Math.abs(menu[x.nome] - x.unitF) >= 0.01) {
        menu[x.nome] = x.unitF;
        salvarNoLocalStorage();
        renderDropdownItens();
        renderConfigMenu();
    }
    const sel = document.getElementById('item');
    if (sel) sel.value = x.nome;
    const q = document.getElementById('quantidade');
    if (q) q.value = String(Math.min(10, Math.max(1, Math.round(x.qtdF))));
    atualizarPreco();
    atualizarBotaoOrdem();
    const sec = document.getElementById('section-adicionar');
    if (sec) { sec.classList.remove('collapsed'); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    mostrarMensagem('✓ "' + x.nome + '" pronto — escolhe quem consumiu e adiciona', true);
}

function faturaUsarTotal() {
    if (!estado.fatura || estado.fatura.total == null) return;
    const el = document.getElementById('total-fatura');
    if (!el) return;
    el.value = estado.fatura.total.toFixed(2);
    atualizarAjuste();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Esconder/mostrar o detalhe. Não apaga nada — para isso há o faturaApagar().
function faturaTogglePainel() {
    _faturaPainel = !_faturaPainel;
    faturaRenderRecon();
}
// Ao trocar de evento o painel arruma-se; a fatura guardada fica no evento.
function faturaFecharRecon() {
    _faturaPainel = false;
    _faturaRows = [];
    faturaRenderRecon();
}

function atualizarReadOnly() {
    const banner = document.getElementById('readonly-banner');
    const sections = ['section-adicionar', 'section-ofertas', 'section-config'];
    // Em modo leitura, a secção de ofertas mostra só os cartões (não escurece),
    // por isso o overlay de leitura aplica-se apenas a estas.
    const dimSections = ['section-adicionar', 'section-config'];

    // Sync fatura buttons
    const hasFatura = !!estado.totalFatura;
    document.getElementById('total-fatura').disabled = hasFatura;
    document.getElementById('pagador-select').disabled = hasFatura;
    document.getElementById('btn-fechar-evento').style.display = hasFatura ? 'none' : '';
    document.getElementById('btn-reabrir-evento').style.display = hasFatura ? '' : 'none';
    const _car = document.getElementById('talao-carimbo');
    if (_car) _car.style.display = hasFatura ? '' : 'none';
    // Ler a fatura continua disponível com a conta fechada — só para consulta:
    // faturaRenderRecon() já esconde "Corrigir preços"/"Usar total"/"Apagar
    // fatura" nesse caso (podeMexer = !modoReadOnly && podeEditarEventoAtual()),
    // por isso importar aqui nunca mexe no que já foi pago.
    const _ocr = document.getElementById('btn-fatura-ocr');
    if (_ocr) _ocr.disabled = !podeEditarEventoAtual();

    // Formulário de ofertas: escondido em evento fechado, visível ao desbloquear
    const ofertaForm = document.getElementById('oferta-form');
    if (ofertaForm) ofertaForm.style.display = modoReadOnly ? 'none' : '';

    if (modoReadOnly) {
        banner.style.display = (_paginaAtual === 'eventos' && isAdmin()) ? 'flex' : 'none';
        dimSections.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('readonly-overlay');
        });
        document.getElementById('section-ofertas').classList.remove('readonly-overlay');
        sections.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.querySelectorAll('button, input, select').forEach(el => {
                if (el.id !== 'total-fatura') el.disabled = true;
            });
        });
        document.getElementById('descricao-evento').disabled = true;
    } else {
        banner.style.display = 'none';
        sections.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.remove('readonly-overlay');
                el.querySelectorAll('button, input, select').forEach(el => el.disabled = false);
            }
        });
        document.getElementById('descricao-evento').disabled = false;
        document.getElementById('total-fatura').disabled = false;
    }
    aplicarColapsosSecoes();
    aplicarPermissoesEdicao();
}

// Devolve a etiqueta da época (ex.: "25/26") para uma data dd/mm/aaaa, com corte a 15/jul.
function _epocaLabel(dataStr) {
    const ts = (typeof _parsePgtoData === 'function') ? _parsePgtoData(dataStr) : 0;
    if (!ts) return '';
    const d = new Date(ts);
    const ano = d.getFullYear();
    const corte = new Date(ano, 6, 15).getTime();
    const anoEp = (ts >= corte) ? ano : ano - 1;
    function p2(n){ n = String(n); return n.length < 2 ? '0' + n : n; }
    return p2(anoEp % 100) + '/' + p2((anoEp + 1) % 100);
}

// Aplica as restrições de edição em função do utilizador (admin vs substituto vs consulta).
function aplicarPermissoesEdicao() {
    const ev = historico.find(h => h.id === eventoAtualId);
    const admin = isAdmin();
    const editavel = podeEditarEvento(ev);
    const banner = document.getElementById('readonly-banner');
    const bSpan = banner ? banner.querySelector('span') : null;
    const bBtn = banner ? banner.querySelector('button') : null;

    // Eliminar evento — só admin e com o jogo ainda aberto (não fechado)
    const btnEliminar = document.getElementById('btn-eliminar-evento');
    if (btnEliminar) btnEliminar.style.display = (admin && ev && !ev.totalFatura) ? '' : 'none';
    // Dropdown personalizada do histórico — visível quando o jogo está fechado
    const _toggle = document.getElementById('historico-toggle-btn');
    const _panel = document.getElementById('historico-panel');
    const _fechado = !!(ev && ev.totalFatura);
    if (_toggle) _toggle.style.display = _fechado ? '' : 'none';
    if (!_fechado && _panel) _panel.classList.remove('open');
    // Meta do título: data + época (corte a 15/jul)
    const _meta = document.getElementById('evento-meta');
    if (_meta) {
        if (ev && ev.data) { _meta.textContent = ev.data + ' · Época ' + _epocaLabel(ev.data); _meta.style.display = ''; }
        else { _meta.style.display = 'none'; _meta.textContent = ''; }
    }

    // Caixa de nomeação de substituto (só admin)
    renderSubstitutoBox(ev);

    if (!editavel) {
        // Consulta total na página de eventos — exceto "Adiciona uma ordem" para
        // um convocado, que pode lançar (só) a própria ordem num evento em aberto.
        const podeOrdemPropria = podeAdicionarOrdemPropria(ev);
        ['section-ofertas', 'section-config'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.add('readonly-overlay');
            el.querySelectorAll('button, input, select, textarea').forEach(c => c.disabled = true);
        });
        const secAdicionar = document.getElementById('section-adicionar');
        if (secAdicionar) {
            if (podeOrdemPropria) {
                secAdicionar.classList.remove('readonly-overlay');
                secAdicionar.querySelectorAll('button, input, select, textarea').forEach(c => c.disabled = false);
                atualizarBotaoOrdem();
            } else {
                secAdicionar.classList.add('readonly-overlay');
                secAdicionar.querySelectorAll('button, input, select, textarea').forEach(c => c.disabled = true);
            }
        }
        const desc = document.getElementById('descricao-evento');
        if (desc) desc.disabled = true;
        ['btn-fechar-evento', 'btn-reabrir-evento'].forEach(id => {
            const b = document.getElementById(id); if (b) b.style.display = 'none';
        });
        if (banner) {
            // Não-admin está sempre em leitura — não vale a pena mostrar o aviso
            banner.style.display = 'none';
        }
    } else {
        // Editável: repor o texto/botão do banner para o comportamento normal de evento fechado
        if (banner) {
            if (modoReadOnly && _paginaAtual === 'eventos' && isAdmin()) {
                banner.style.display = 'flex';
                if (bSpan) bSpan.textContent = '👁️ Modo leitura';
                if (bBtn) bBtn.style.display = '';
            } else {
                banner.style.display = 'none';
            }
        }
    }
}

// Caixa (só admin) para nomear/remover o substituto de um evento em aberto.
function renderSubstitutoBox(ev) {
    const box = document.getElementById('substituto-box');
    if (!box) return;
    if (!isAdmin() || !ev) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const aberto = !ev.totalFatura;
    if (!aberto) {
        if (ev.substituto) {
            box.style.display = '';
            box.innerHTML = `<div class="subst-info">👤 Substituto: <strong>${ev.substituto}</strong> · evento fechado</div>`;
        } else { box.style.display = 'none'; box.innerHTML = ''; }
        return;
    }
    box.style.display = '';
    const emails = _allowedUsersCache.filter(e => e.toLowerCase() !== ADMIN_EMAIL.toLowerCase());
    const opts = ['<option value="">— sem substituto (só admin edita) —</option>']
        .concat(emails.map(e => `<option value="${e}" ${ev.substituto === e ? 'selected' : ''}>${e}</option>`))
        .join('');
    box.innerHTML = `<div class="subst-box">
        <span class="subst-label">👤 Substituto para este evento</span>
        <div class="subst-row">
            <select id="subst-select">${opts}</select>
            <button onclick="definirSubstituto()">Definir</button>
        </div>
        <span class="subst-hint">O substituto pode registar a conta e os pagamentos deste evento enquanto não estiveres presente.</span>
    </div>`;
}

async function definirSubstituto() {
    if (!isAdmin()) return;
    const ev = historico.find(h => h.id === eventoAtualId);
    if (!ev) return;
    const sel = document.getElementById('subst-select');
    const email = sel ? (sel.value || null) : null;
    ev.substituto = email;
    salvarHistoricoLocal();
    await sbDefinirSubstituto(ev.id, email);
    renderSubstitutoBox(ev);
    mostrarMensagem(email ? ('✓ Substituto definido: ' + email) : '✓ Substituto removido', true);
}

async function desbloquearEvento() {
    if (!podeEditarEventoAtual()) { mostrarMensagem('⚠️ Sem permissão para editar este evento', false); return; }
    const ok = await mostrarModal({
        icon: '🔓',
        title: 'Desbloquear evento',
        msg: 'O evento será reaberto para edição. A fatura será removida.',
        confirmText: 'Desbloquear',
        cancelText: 'Cancelar'
    });
    if (!ok) return;
    modoReadOnly = false;
    estado.totalFatura = null;
    estado.pagador = '';
    estado.dividas = {};
    document.getElementById('total-fatura').disabled = false;
    document.getElementById('pagador-select').disabled = false;
    document.getElementById('pagador-select').value = '';
    document.getElementById('ajuste-info').style.display = 'none';
    salvarNoLocalStorage();
    atualizarReadOnly();
    atualizarUI();
    renderContas();
    mostrarMensagem('🔓 Evento desbloqueado para edição', true);
}

// ── PAGADOR & CONTAS (DÍVIDAS) ──────────────────────────────────────────────

function renderPagadorSelect() {
    const sel = document.getElementById('pagador-select');
    const current = estado.pagador || '';
    sel.innerHTML = '<option value="">-- Seleciona --</option>';
    amigos.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a; opt.textContent = a;
        if (a === current) opt.selected = true;
        sel.appendChild(opt);
    });
}

function atualizarPagador() {
    estado.pagador = document.getElementById('pagador-select').value;
    salvarNoLocalStorage();
}

let _contasTabAtual = 'saldos';
let pagamentos = [];
let divisoes = {};   // {eventoId: {pessoa: quota}} — gravado na BD, imutável após fecho
let _paginaAtual = 'eventos';
let _pgtoSearchQuery = '';
let _pgtoFilterPessoa = '';
let _pgtoFilterEvento = '';
let _evtFilterPessoa = '';
let _evtFilterJogo = '';

// Helper: strip 'Sporting' prefix from event description for compact combo labels
function comboLabel(descricao) {
    let label = (descricao || 'Sem nome').replace(/\bSporting\b\s*/gi, '').trim();
    return label || descricao || 'Sem nome';
}

function shortDate(d) {
    if (!d) return '';
    var parts = d.split('/');
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : d;
}

function carregarPagamentos() {
    const saved = localStorage.getItem('splitbill_pagamentos');
    if (saved) { try { pagamentos = JSON.parse(saved); } catch(e) { pagamentos = []; } }
}

function salvarPagamentos() {
    localStorage.setItem('splitbill_pagamentos', JSON.stringify(pagamentos));
    sbScheduleAutoSave();
}

// ── Page switching ──

function mudarPagina(pagina) {
    _paginaAtual = pagina;
    if (window.sbEsconderSplash) window.sbEsconderSplash();
    try { localStorage.setItem('sb_pagina', pagina); } catch(e) {}
    var _pi = document.getElementById('page-inicio');
    if (_pi) _pi.style.display = pagina === 'inicio' ? '' : 'none';
    var _tn = document.querySelector('.top-nav');
    if (_tn) _tn.style.display = 'none';
    var _bv = document.getElementById('sbi-voltar-hdr');
    if (_bv) _bv.style.display = pagina === 'inicio' ? 'none' : 'inline-flex';
    if (pagina === 'inicio' && typeof renderInicio === 'function') renderInicio();
    document.getElementById('page-eventos').style.display = pagina === 'eventos' ? '' : 'none';
    document.getElementById('page-pagamentos').style.display = pagina === 'pagamentos' ? '' : 'none';
    document.getElementById('page-geral').style.display = pagina === 'geral' ? '' : 'none';
    document.getElementById('readonly-banner').style.display = (pagina === 'eventos' && modoReadOnly && isAdmin()) ? '' : 'none';
    document.getElementById('header-evento-context').style.display = pagina === 'eventos' ? '' : 'none';
    // Adjust top-nav bottom style based on whether event context is visible
    const topNav = document.querySelector('.top-nav');
    if (pagina === 'eventos') {
        topNav.style.borderRadius = '0';
        topNav.style.marginBottom = '0';
    } else {
        topNav.style.borderRadius = '0 0 8px 8px';
        topNav.style.marginBottom = '20px';
    }
    document.getElementById('nav-eventos').classList.toggle('active', pagina === 'eventos');
    document.getElementById('nav-pagamentos').classList.toggle('active', pagina === 'pagamentos');
    // FAB visibility: only on pagamentos page + permissão
    const fab = document.getElementById('fab-pgto');
    fab.style.display = (pagina === 'pagamentos' && ghHasToken()) ? 'block' : 'none';
    // FAB Novo Evento: só no ecrã inicial + admin
    const fabNovo = document.getElementById('fab-novo');
    if (fabNovo) fabNovo.style.display = (pagina === 'inicio' && isAdmin()) ? 'inline-flex' : 'none';
    if (pagina === 'pagamentos') renderContas();
    aplicarPermissoesEdicao();
}

function atualizarNavBadge() {
    const saldos = calcularSaldos();
    const badge = document.getElementById('nav-pgto-badge');

    if (isAdmin()) {
        let total = 0;
        Object.values(saldos).forEach(s => total += s.saldo);
        if (total > 0.005) {
            badge.className = 'top-nav-badge badge-devo';
            badge.textContent = '€' + total.toFixed(2);
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
        return;
    }

    // Não-admin: separar o que me devem (receber) do que devo (pagar)
    let aReceber = 0, aDevo = 0;
    Object.entries(saldos).forEach(([pessoa, s]) => {
        s.eventos.forEach(e => {
            if (e.restante < 0.01) return;
            if (ehEu(pessoa)) aDevo += e.restante;
            else if (ehEu(e.pagador)) aReceber += e.restante;
        });
    });
    aReceber = Math.round(aReceber * 100) / 100;
    aDevo = Math.round(aDevo * 100) / 100;

    if (aReceber < 0.01 && aDevo < 0.01) {
        badge.style.display = 'none';
        badge.innerHTML = '';
        return;
    }
    const partes = [];
    if (aReceber >= 0.01) partes.push('<span class="badge-receber">+€' + aReceber.toFixed(2) + '</span>');
    if (aDevo >= 0.01)    partes.push('<span class="badge-devo">−€' + aDevo.toFixed(2) + '</span>');
    badge.className = 'top-nav-badge badge-split';
    badge.innerHTML = partes.join('');
    badge.style.display = 'inline-flex';
}

// ── FAB ──

function abrirFabPanel() {
    document.getElementById('fab-panel').style.display = 'block';
    document.getElementById('fab-backdrop').style.display = 'block';
    document.getElementById('fab-pgto').style.display = 'none';
    // Default date to today
    const dataInput = document.getElementById('pgto-data');
    if (dataInput) dataInput.value = new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric'});
    renderPgtoForm();
}

function fecharFabPanel() {
    document.getElementById('fab-panel').style.display = 'none';
    document.getElementById('fab-backdrop').style.display = 'none';
    if (_paginaAtual === 'pagamentos' && ghHasToken()) {
        document.getElementById('fab-pgto').style.display = 'block';
    }
}

function abrirPagamentoPrePreenchido(pessoa, eventoId) {
    // Open the FAB panel pre-filled with this person and event
    document.getElementById('fab-panel').style.display = 'block';
    document.getElementById('fab-backdrop').style.display = 'block';
    document.getElementById('fab-pgto').style.display = 'none';

    // Default date to today
    const dataInput = document.getElementById('pgto-data');
    if (dataInput) dataInput.value = new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric'});

    renderPgtoForm();

    // Pre-fill pessoa
    const selPessoa = document.getElementById('pgto-pessoa');
    if (selPessoa) {
        selPessoa.value = pessoa;
    }

    atualizarPgtoForm();

    // Pre-fill evento after the dropdown is rendered
    setTimeout(() => {
        const selEvento = document.getElementById('pgto-evento');
        if (selEvento) {
            selEvento.value = String(eventoId);
            atualizarPgtoValorEvento();
        }
    }, 50);
}

function mudarTabContas(tab) {
    _contasTabAtual = tab;
    document.querySelectorAll('.contas-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    renderContas();
}

// ── Core: calculate saldos considering dividas + pagamentos ──

function getDividasPorPessoaPorEvento() {
    const result = {};
    historico.forEach(ev => {
        if (!ev.totalFatura || !ev.pagador) return;
        // Preferir divisoes da BD (fixados no fecho); fallback para ev.dividas (legacy)
        const div = divisoes[ev.id];
        const fonte = div
            ? Object.entries(div)
            : Object.entries(ev.dividas || {}).map(([p, d]) => [p, typeof d === 'object' ? d.valor : d]);
        fonte.forEach(([pessoa, valor]) => {
            if (!valor || valor <= 0.005) return;
            if (!result[pessoa]) result[pessoa] = [];
            result[pessoa].push({
                eventoId: ev.id,
                descricao: ev.descricao || 'Sem nome',
                data: ev.data || '—',
                valor: parseFloat(valor),
                pagador: ev.pagador
            });
        });
    });
    return result;
}

function calcularSaldos() {
    const dividasPE = getDividasPorPessoaPorEvento();
    const pgtosPP = {};
    pagamentos.forEach(p => {
        if (!pgtosPP[p.pessoa]) pgtosPP[p.pessoa] = [];
        pgtosPP[p.pessoa].push(p);
    });
    const saldos = {};
    const todasPessoas = new Set([...Object.keys(dividasPE), ...Object.keys(pgtosPP)]);

    todasPessoas.forEach(pessoa => {
        const eventos = (dividasPE[pessoa] || []).map(e => ({...e, restante: e.valor}));
        const pgtos = pgtosPP[pessoa] || [];
        let totalDivida = eventos.reduce((s, e) => s + e.valor, 0);
        let totalPago = 0;

        // Cada pagamento abate a dívida do seu evento concreto. tipo='pendente' é
        // só uma declaração do utilizador ("já paguei") por confirmar pelo admin —
        // não abate nada enquanto não for confirmada (vira tipo='evento' nessa altura).
        pgtos.filter(p => p.tipo !== 'pendente' && (p.tipo === 'evento' || p.eventoId)).forEach(p => {
            const ev = eventos.find(e => e.eventoId === p.eventoId);
            if (ev) {
                const abate = Math.min(ev.restante, p.valor);
                ev.restante -= abate;
            }
            totalPago += p.valor;
        });

        saldos[pessoa] = {
            divida: totalDivida,
            pago: totalPago,
            saldo: Math.max(0, Math.round(eventos.reduce((s, e) => s + e.restante, 0) * 100) / 100),
            eventos
        };
    });
    return saldos;
}

// Ensure closed events always have dividas — runs on every render to handle sync gaps
function ensureDividasExist() {
    let changed = false;
    historico.forEach(ev => {
        if (!ev.totalFatura || !ev.pagador) return;
        if (ev.dividas && Object.keys(ev.dividas).length > 0) return; // already has dividas
        ev.dividas = {};
        const contaFinal = calcularContaFinalEvento(ev);
        Object.keys(contaFinal).forEach(pessoa => {
            if (pessoa !== ev.pagador && contaFinal[pessoa] > 0.005) {
                ev.dividas[pessoa] = { valor: Math.round(contaFinal[pessoa] * 100) / 100 };
            }
        });
        changed = true;
    });
    if (changed) salvarHistoricoLocal();
}

// ── Render ──

function renderContas() {
    const lista = document.getElementById('contas-lista');
    const resumo = document.getElementById('contas-resumo');
    if (!lista) return;

    // Ensure all closed events have dividas generated
    ensureDividasExist();

    if (_contasTabAtual === 'saldos') renderContasSaldos(lista, resumo);
    else if (_contasTabAtual === 'eventos') renderContasEventos(lista, resumo);
    else if (_contasTabAtual === 'pagamentos') renderContasPagamentos(lista, resumo);

    atualizarNavBadge();
}

function renderContasSaldos(lista, resumo) {
    const saldos = calcularSaldos();
    // Não-admin sem nome associado: avisar em vez de mostrar lista vazia
    if (!isAdmin() && meusAmigos().length === 0) { lista.innerHTML = _avisoSemAmigo(); resumo.innerHTML = ''; return; }
    // Only show people with outstanding balance
    let pessoas = Object.keys(saldos)
        .filter(p => saldos[p].saldo >= 0.01)
        .sort((a, b) => saldos[b].saldo - saldos[a].saldo);

    // Não-admin: só dívidas próprias (sou o devedor) ou valores a receber por mim (sou o credor de algum evento pendente)
    if (!isAdmin()) {
        pessoas = pessoas.filter(p => ehEu(p) || saldos[p].eventos.some(e => e.restante >= 0.01 && ehEu(e.pagador)));
    }

    if (pessoas.length === 0) {
        lista.innerHTML = '<div class="contas-vazio">✅ Não há dívidas pendentes</div>';
        resumo.innerHTML = '';
        return;
    }

    lista.innerHTML = pessoas.map(pessoa => {
        const s = saldos[pessoa];
        // Only show events with remaining balance
        const eventosPendentes = s.eventos.filter(e => e.restante >= 0.01);

        // Agrupar eventos pendentes por credor (a quem se deve)
        const porCredor = {};
        eventosPendentes.forEach(e => {
            const c = e.pagador || '\u2014';
            (porCredor[c] = porCredor[c] || []).push(e);
        });
        const subtotalDe = c => porCredor[c].reduce((t, e) => t + e.restante, 0);
        let credores = Object.keys(porCredor).sort((a, b) => subtotalDe(b) - subtotalDe(a));
        // Não-admin a ver dívida de outra pessoa: só os montantes que essa pessoa me deve a mim
        if (!isAdmin() && !ehEu(pessoa)) credores = credores.filter(c => ehEu(c));

        const renderEvento = e => {
            // Get consumption detail for this person in this event
            const ev = historico.find(h => h.id === e.eventoId);
            let consumoStr = '';
            if (ev && ev.ordens) {
                const consumos = {};
                ev.ordens.forEach(o => {
                    if (o.amigos.includes(pessoa)) {
                        const share = o.quantidade / o.amigos.length;
                        consumos[o.item] = (consumos[o.item] || 0) + share;
                    }
                });
                consumoStr = Object.keys(consumos).sort().map(item => {
                    const qtd = consumos[item];
                    return (Number.isInteger(qtd) ? qtd : qtd.toFixed(1)) + '\u00d7 ' + item;
                }).join(', ');
            }
            const hasToken = podeRegistarDiretamente(pessoa, e.eventoId);
            const pessoaEsc = pessoa.replace(/'/g, "\\'");
            let acaoHtml = '';
            if (!hasToken && ehEu(pessoa) && PAGAMENTOS_PENDENTE_COL) {
                const pendenteAqui = pagamentos.find(p => p.tipo === 'pendente' && p.pessoa === pessoa && String(p.eventoId) === String(e.eventoId));
                acaoHtml = pendenteAqui
                    ? '<div class="saldo-evento-pendente" onclick="event.stopPropagation()">\u23f3 Pedido enviado \u2014 a aguardar confirma\u00e7\u00e3o <button class="link-cancelar" onclick="cancelarDeclaracaoPagamento(' + pendenteAqui.id + ')">cancelar</button></div>'
                    : '<button class="btn-ja-paguei" onclick="event.stopPropagation();declararPagamento(\'' + pessoaEsc + '\',' + e.eventoId + ',' + e.restante + ')">\ud83d\udcb8 J\u00e1 paguei?</button>';
            }
            // Bot\u00e3o de lembrete: s\u00f3 para quem tem o dinheiro a receber neste evento
            // concreto (o pagador) ou o admin \u2014 nunca para a pr\u00f3pria pessoa devedora.
            if ((ehEu(e.pagador) || isAdmin()) && !ehEu(pessoa) && PUSH_COL) {
                acaoHtml += '<button class="btn-lembrar" onclick="event.stopPropagation();enviarLembretePagamento(\'' + pessoaEsc + '\',' + e.eventoId + ',' + e.restante + ')">\ud83d\udd14 Lembrar</button>';
            }
            return '<div class="saldo-evento-row"' + (hasToken ? ' style="cursor:pointer;" onclick="abrirPagamentoPrePreenchido(\'' + pessoaEsc + '\',' + e.eventoId + ')" title="Clica para registar pagamento"' : '') + '>'
                + '<div class="saldo-evento-info">'
                + '<span class="saldo-evento-nome">\u26BD ' + e.descricao + '</span>'
                + '<span class="saldo-evento-data">' + (e.data || '\u2014') + '</span>'
                + '</div>'
                + (consumoStr ? '<div class="saldo-evento-consumo">' + consumoStr + '</div>' : '')
                + '<div class="saldo-evento-valor" style="text-align:right;">\u20ac' + e.restante.toFixed(2)
                + (e.restante < e.valor - 0.005 ? ' <span style="color:#0E7A4F;font-size:10px;">(parcial)</span>' : '')
                + '</div>'
                + acaoHtml
                + '</div>';
        };

        const blocosHtml = credores.map(credor => {
            const subtotal = subtotalDe(credor);
            return '<div class="saldo-credor-bloco">'
                + '<div class="saldo-credor-header">'
                + '<span>\uD83D\uDCB3 Deve a <strong>' + credor + '</strong></span>'
                + '<span class="saldo-credor-subtotal">\u20ac' + subtotal.toFixed(2) + '</span>'
                + '</div>'
                + porCredor[credor].map(renderEvento).join('')
                + '</div>';
        }).join('');

        // Total a mostrar no cabeçalho da pessoa:
        // - admin vê o saldo global da pessoa
        // - não-admin vê apenas o que lhe é relevante (a sua própria dívida, ou o que essa pessoa lhe deve a si)
        let totalCabecalho = s.saldo;
        if (!isAdmin() && !ehEu(pessoa)) {
            totalCabecalho = credores.reduce((t, c) => t + subtotalDe(c), 0);
        }
        totalCabecalho = Math.round(totalCabecalho * 100) / 100;

        return '<div class="saldo-pessoa-card">'
            + '<div class="saldo-pessoa-header">'
            + '<span class="saldo-pessoa-nome">\uD83D\uDC64 ' + pessoa + (ehEu(pessoa) ? ' <span style="font-size:10px;color:#0E7A4F;font-weight:600;">(tu)</span>' : '') + '</span>'
            + '<span class="saldo-pessoa-total">\u20ac' + totalCabecalho.toFixed(2) + '</span>'
            + '</div>'
            + blocosHtml
            + '</div>';
    }).join('');

    if (isAdmin()) {
        let totalPendente = 0;
        Object.values(saldos).forEach(s => totalPendente += s.saldo);
        if (totalPendente > 0.005) {
            resumo.innerHTML = `
            <div class="contas-resumo-total">
                <span class="label">Total pendente</span>
                <span class="valor">€${totalPendente.toFixed(2)}</span>
            </div>`;
        } else {
            resumo.innerHTML = '<div style="text-align:center;font-size:13px;color:#0E7A4F;padding:10px;font-weight:600;">Tudo liquidado</div>';
        }
        return;
    }

    // Não-admin: separar o que me devem (a receber) do que devo (a pagar)
    let aReceber = 0, aDevo = 0;
    pessoas.forEach(p => {
        saldos[p].eventos.forEach(e => {
            if (e.restante < 0.01) return;
            if (ehEu(p)) aDevo += e.restante;
            else if (ehEu(e.pagador)) aReceber += e.restante;
        });
    });
    aReceber = Math.round(aReceber * 100) / 100;
    aDevo = Math.round(aDevo * 100) / 100;

    if (aReceber < 0.01 && aDevo < 0.01) {
        resumo.innerHTML = '<div style="text-align:center;font-size:13px;color:#0E7A4F;padding:10px;font-weight:600;">Tudo liquidado</div>';
        return;
    }
    const linhas = [];
    if (aReceber >= 0.01) linhas.push(`
        <div class="resumo-fluxo resumo-receber">
            <span class="label">A receber</span>
            <span class="valor">€${aReceber.toFixed(2)}</span>
        </div>`);
    if (aDevo >= 0.01) linhas.push(`
        <div class="resumo-fluxo resumo-pagar">
            <span class="label">A pagar</span>
            <span class="valor">€${aDevo.toFixed(2)}</span>
        </div>`);
    resumo.innerHTML = '<div class="resumo-fluxo-wrap">' + linhas.join('') + '</div>';
}

// "Prescrição" é vocabulário de admin — o utilizador não deve perceber que a dívida
// foi dada como perdida. Para ele é só um pagamento que falta confirmar.
function notaPrescrita(pessoa, presc) {
    if (isAdmin()) return 'Prescrita' + (presc && presc.data ? ' em ' + presc.data : '') + ' — confirmar se chegou a pagar';
    return ehEu(pessoa) ? 'Confirma se já pagaste este valor' : 'Pagamento por confirmar';
}

// Link "declarar pagamento"/"cancelar pedido" a seguir à nota de dívida prescrita —
// só para a própria pessoa, e só se a migração db/pagamentos-pendentes.sql já correu.
function notaAcaoHtml(pessoa, ev, dividaObj) {
    if (isAdmin() || !ehEu(pessoa) || !PAGAMENTOS_PENDENTE_COL) return '';
    const pendenteAqui = pagamentos.find(pg => pg.tipo === 'pendente' && pg.pessoa === pessoa && String(pg.eventoId) === String(ev.id));
    if (pendenteAqui) return ' · <button class="link-cancelar" onclick="cancelarDeclaracaoPagamento(' + pendenteAqui.id + ')">cancelar pedido</button>';
    return ' · <button class="link-declarar" onclick="declararPagamento(\'' + pessoa.replace(/'/g, "\\'") + '\',' + ev.id + ',' + dividaObj.valor + ')">declarar pagamento</button>';
}

function renderContasEventos(lista, resumo) {
    let eventosFechados = historico.filter(ev => ev.totalFatura && ev.pagador);
    // Não-admin sem nome associado: avisar
    if (!isAdmin() && meusAmigos().length === 0) { lista.innerHTML = _avisoSemAmigo(); resumo.innerHTML = ''; return; }
    // Não-admin: só eventos onde estou envolvido (paguei eu, ou devo nesse evento)
    if (!isAdmin()) {
        eventosFechados = eventosFechados.filter(ev => ehEu(ev.pagador) || Object.keys(ev.dividas || {}).some(p => ehEu(p)));
    }
    if (eventosFechados.length === 0) {
        lista.innerHTML = '<div class="contas-vazio">Nenhuma conta fechada ainda</div>';
        resumo.innerHTML = '';
        return;
    }

    const saldos = calcularSaldos();

    // Build filter options
    const todasPessoas = [...new Set(eventosFechados.flatMap(ev => Object.keys(ev.dividas || {})))].sort();
    const pessoaOpts = todasPessoas.map(p =>
        '<option value="' + p + '"' + (_evtFilterPessoa === p ? ' selected' : '') + '>' + p + '</option>'
    ).join('');
    const jogoOpts = [...eventosFechados].reverse().map(ev => {
        const label = comboLabel(ev.descricao) + ' · ' + shortDate(ev.data);
        return '<option value="' + ev.id + '"' + (_evtFilterJogo === String(ev.id) ? ' selected' : '') + '>' + label + '</option>';
    }).join('');

    const filtersHtml = '<div style="display:flex;gap:6px;margin-bottom:10px;">'
        + '<select class="pgto-search" style="flex:1;font-size:11px;" onchange="_evtFilterPessoa=this.value;renderContasEventos(document.getElementById(\'contas-lista\'),document.getElementById(\'contas-resumo\'))">'
        + '<option value="">\uD83D\uDC64 Todos</option>' + pessoaOpts + '</select>'
        + '<select class="pgto-search" style="flex:1;font-size:11px;" onchange="_evtFilterJogo=this.value;renderContasEventos(document.getElementById(\'contas-lista\'),document.getElementById(\'contas-resumo\'))">'
        + '<option value="">\u26BD Todos os jogos</option>' + jogoOpts + '</select>'
        + '</div>';

    const eventosFiltrados = [...eventosFechados].reverse().filter(ev => {
        if (_evtFilterJogo && String(ev.id) !== _evtFilterJogo) return false;
        if (_evtFilterPessoa && !Object.keys(ev.dividas || {}).includes(_evtFilterPessoa)) return false;
        return true;
    });

    const html = eventosFiltrados.map(ev => {
        const dividas = ev.dividas || {};
        let pessoas = Object.keys(dividas).sort();
        if (_evtFilterPessoa) pessoas = pessoas.filter(p => p === _evtFilterPessoa);
        // Não-admin que não pagou este evento: só vê a sua própria dívida (não as dos outros)
        if (!isAdmin() && !ehEu(ev.pagador)) pessoas = pessoas.filter(p => ehEu(p));
        if (pessoas.length === 0) return '';

        const dividasHtml = pessoas.map(p => {
            const d = dividas[p];
            const pessoaSaldo = saldos[p];
            const evInfo = pessoaSaldo ? pessoaSaldo.eventos.find(e => e.eventoId === ev.id) : null;
            const restante = evInfo ? evInfo.restante : d.valor;
            const isPago = restante < 0.01;
            const prescricao = isPago ? pagamentos.find(pg => pg.tipo === 'prescricao' && pg.pessoa === p && String(pg.eventoId) === String(ev.id)) : null;
            const isPrescrita = !!prescricao;
            const consumos = {};
            (ev.ordens || []).forEach(o => {
                if (o.amigos.includes(p)) {
                    const share = o.quantidade / o.amigos.length;
                    consumos[o.item] = (consumos[o.item] || 0) + share;
                }
            });
            const consumoStr = Object.keys(consumos).sort().map(item => {
                const qtd = consumos[item];
                const qtdStr = Number.isInteger(qtd) ? qtd : qtd.toFixed(1);
                return qtdStr + '\u00d7 ' + item;
            }).join(', ');
            const icone = isPrescrita ? '<span class="icone-prescrita">?</span>' : (isPago ? '<span style="color:#0E7A4F;font-size:16px;">✓</span>' : '\u23f3');
            return '<div class="contas-divida-item' + (isPrescrita ? ' prescrita' : '') + '" style="flex-wrap:wrap;">'
                + '<span class="nome">' + p + '</span>'
                + '<span class="valor ' + (isPrescrita ? 'prescrita' : (isPago ? 'pago' : 'pendente')) + '">\u20ac' + d.valor.toFixed(2) + (!isPago && restante < d.valor - 0.005 ? ' (resta \u20ac' + restante.toFixed(2) + ')' : '') + ' <span style="display:inline-block;width:24px;text-align:center;margin-left:6px;">' + icone + '</span></span>'
                + (isPrescrita ? '<div class="nota-prescrita">' + notaPrescrita(p, prescricao) + notaAcaoHtml(p, ev, d) + '</div>' : '')
                + (consumoStr ? '<div style="width:100%;font-size:11px;color:#7C8782;margin-top:2px;">' + consumoStr + '</div>' : '')
                + '</div>';
        }).join('');

        // Pagador consumption row (gray, informational — not a debt)
        let pagadorConsumoHtml = '';
        if (ev.pagador) {
            const pagadorConsumos = {};
            (ev.ordens || []).forEach(o => {
                if (o.amigos.includes(ev.pagador)) {
                    const share = o.quantidade / o.amigos.length;
                    pagadorConsumos[o.item] = (pagadorConsumos[o.item] || 0) + share;
                }
            });
            const pagadorConsumoStr = Object.keys(pagadorConsumos).sort().map(item => {
                const qtd = pagadorConsumos[item];
                const qtdStr = Number.isInteger(qtd) ? qtd : qtd.toFixed(1);
                return qtdStr + '\u00d7 ' + item;
            }).join(', ');
            const contaFinal = calcularContaFinalEvento(ev);
            const pagadorValor = contaFinal[ev.pagador] || 0;
            pagadorConsumoHtml = '<div class="contas-divida-item" style="flex-wrap:wrap;opacity:0.65;border:1px dashed #C8D0C8;background:#F7F8F4;">'
                + '<span class="nome" style="color:#5B6661;">' + ev.pagador + ' <span style="font-weight:400;font-size:11px;">(pagou)</span></span>'
                + '<span class="valor" style="color:#5B6661;font-weight:600;">\u20ac' + pagadorValor.toFixed(2) + ' <span style="display:inline-block;width:24px;text-align:center;margin-left:6px;">💳</span></span>'
                + (pagadorConsumoStr ? '<div style="width:100%;font-size:11px;color:#9AA39D;margin-top:2px;">' + pagadorConsumoStr + '</div>' : '')
                + '</div>';
        }

        const totalEvento = pessoas.reduce((sum, p) => sum + dividas[p].valor, 0);

        return `
        <div class="contas-evento">
            <div class="contas-evento-header" onclick="navegarHistorico(${ev.id})">
                <span class="contas-evento-titulo">${ev.descricao || 'Sem nome'}</span>
                <span class="contas-evento-data">${ev.data || '—'}</span>
            </div>
            <div class="contas-evento-pagador">💳 Pago por: <strong>${ev.pagador}</strong> · Fatura: €${ev.totalFatura.toFixed(2)}</div>
            ${pagadorConsumoHtml}
            ${dividasHtml}
        </div>`;
    }).join('');

    lista.innerHTML = filtersHtml + (eventosFiltrados.length === 0
        ? '<div class="contas-vazio">Nenhum resultado encontrado</div>'
        : html);

    resumo.innerHTML = '';
}

// Parse "dd/mm/aaaa, hh:mm" or "dd/mm/aaaa" into a sortable timestamp
function _parsePgtoData(str) {
    if (!str) return 0;
    var m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/);
    if (!m) return 0;
    return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[4] || 0), parseInt(m[5] || 0)).getTime();
}

function renderContasPagamentos(lista, resumo) {
    // Não-admin sem nome associado: avisar
    if (!isAdmin() && meusAmigos().length === 0) { lista.innerHTML = _avisoSemAmigo(); resumo.innerHTML = ''; return; }
    // Universo de pagamentos visíveis. Não-admin: só os feitos por mim ou recebidos por mim.
    var basePagamentos = pagamentos;
    if (!isAdmin()) {
        basePagamentos = pagamentos.filter(function(p) {
            if (ehEu(p.pessoa)) return true;                       // pagamento (ou prescrição) que me diz respeito
            if (p.eventoId) {
                var evp = historico.find(function(e) { return e.id === p.eventoId; });
                if (evp && ehEu(evp.pagador)) return true;         // pagamento/prescrição que me era devido
            }
            return false;
        });
    }
    // Build filter combo options
    var allPessoas = [];
    var allEventosMap = {};
    var allEventos = [];
    var _seen = {};
    basePagamentos.forEach(function(p) {
        if (!_seen[p.pessoa]) { allPessoas.push(p.pessoa); _seen[p.pessoa] = true; }
        if (p.eventoId && !allEventosMap[p.eventoId]) {
            var ev = historico.find(function(e) { return e.id === p.eventoId; });
            var desc = ev ? (ev.descricao || 'Sem nome') : 'Evento removido';
            allEventosMap[p.eventoId] = desc;
            allEventos.push({ id: p.eventoId, desc: desc });
        }
    });
    allPessoas.sort();

    var pessoaOpts = allPessoas.map(function(p) {
        return '<option value="' + p + '"' + (_pgtoFilterPessoa === p ? ' selected' : '') + '>' + p + '</option>';
    }).join('');
    var eventoOpts = allEventos.sort(function(a, b) {
        var evA = historico.find(function(h) { return h.id === a.id; });
        var evB = historico.find(function(h) { return h.id === b.id; });
        var dA = evA && evA.data ? evA.data.split('/').reverse().join('') : '0';
        var dB = evB && evB.data ? evB.data.split('/').reverse().join('') : '0';
        return dB.localeCompare(dA);
    }).map(function(e) {
        var ev = historico.find(function(h) { return h.id === e.id; });
        var dataStr = ev && ev.data ? ' · ' + shortDate(ev.data) : '';
        return '<option value="' + e.id + '"' + (_pgtoFilterEvento === String(e.id) ? ' selected' : '') + '>' + comboLabel(e.desc) + dataStr + '</option>';
    }).join('');

    var filtersHtml = '<div style="display:flex;gap:6px;margin-bottom:10px;">'
        + '<select class="pgto-search" style="flex:1;font-size:11px;" onchange="_pgtoFilterPessoa=this.value;renderContasPagamentos(document.getElementById(\'contas-lista\'),document.getElementById(\'contas-resumo\'))">'
        + '<option value="">\uD83D\uDC64 Todos</option>' + pessoaOpts + '</select>'
        + '<select class="pgto-search" style="flex:1;font-size:11px;" onchange="_pgtoFilterEvento=this.value;renderContasPagamentos(document.getElementById(\'contas-lista\'),document.getElementById(\'contas-resumo\'))">'
        + '<option value="">\u26BD Todos os jogos</option>'
        + eventoOpts + '</select></div>';

    if (basePagamentos.length === 0) {
        lista.innerHTML = filtersHtml + '<div class="contas-vazio">Nenhum pagamento registado</div>';
        resumo.innerHTML = '';
        return;
    }

    var hasToken = ghHasToken();

    var filtrados = basePagamentos.slice().sort(function(a, b) {
        return _parsePgtoData(b.data) - _parsePgtoData(a.data);
    }).filter(function(p) {
        if (_pgtoFilterPessoa && p.pessoa !== _pgtoFilterPessoa) return false;
        if (_pgtoFilterEvento) {
            if (String(p.eventoId) !== _pgtoFilterEvento) return false;
        }
        return true;
    });

    var itemsHtml = filtrados.map(function(p) {
        var eventoDesc = (function() { var ev = historico.find(function(e) { return e.id === p.eventoId; }); return ev ? (ev.descricao || 'Sem nome') : 'Evento removido'; })();

        var isPrescricao = p.tipo === 'prescricao';
        var isPendente = p.tipo === 'pendente';

        // Consumption detail
        var consumoStr = '';
        if (p.eventoId) {
            var ev = historico.find(function(e) { return e.id === p.eventoId; });
            if (ev && ev.ordens) {
                var consumos = {};
                ev.ordens.forEach(function(o) {
                    if (o.amigos.includes(p.pessoa)) {
                        var share = o.quantidade / o.amigos.length;
                        consumos[o.item] = (consumos[o.item] || 0) + share;
                    }
                });
                consumoStr = Object.keys(consumos).sort().map(function(item) {
                    var qtd = consumos[item];
                    var qtdStr = Number.isInteger(qtd) ? qtd : qtd.toFixed(1);
                    return qtdStr + '\u00d7 ' + item;
                }).join(', ');
            }
        }

        var acoes;
        if (isPendente) {
            if (podeConfirmarPedidosDoEvento(p.eventoId)) {
                acoes = '<button class="pgto-edit" onclick="confirmarPedidoPagamento(' + p.id + ')" title="Confirmar">\u2713</button><button class="pgto-delete" onclick="rejeitarPedidoPagamento(' + p.id + ')" title="Rejeitar">\u00d7</button>';
            } else if (p.declaradoPor && p.declaradoPor === emailSessao()) {
                acoes = '<button class="pgto-delete" onclick="cancelarDeclaracaoPagamento(' + p.id + ')" title="Cancelar pedido">\u00d7</button>';
            } else {
                acoes = '';
            }
        } else {
            acoes = podeEditarPagamentoDoEvento(p.eventoId) ? '<button class="pgto-edit" onclick="editarPagamento(' + p.id + ')" title="Editar data">\u270e</button><button class="pgto-delete" onclick="removerPagamento(' + p.id + ')" title="Remover">\u00d7</button>' : '';
        }
        var recebedorStr = (function() {
            if (p.eventoId) {
                var evr = historico.find(function(e) { return e.id === p.eventoId; });
                if (evr && evr.pagador && evr.pagador !== p.pessoa) {
                    var etiqueta;
                    if (isPendente) etiqueta = podeConfirmarPedidosDoEvento(p.eventoId) ? '(pedido de pagamento · devia a ' + evr.pagador + ')' : '(por confirmar · a ' + evr.pagador + ')';
                    else if (isPrescricao) etiqueta = isAdmin() ? '(prescrita · devia a ' + evr.pagador + ')' : '(por confirmar · a ' + evr.pagador + ')';
                    else etiqueta = '(pagou ao ' + evr.pagador + ')';
                    return ' <span style="font-size:10.5px;font-weight:400;color:' + ((isPrescricao || isPendente) ? '#B8911F' : '#9AA5A0') + ';">' + etiqueta + '</span>';
                }
            }
            return '';
        })();
        return '<div class="pgto-hist-item' + ((isPrescricao || isPendente) ? ' prescrita' : '') + '" id="pgto-item-' + p.id + '" style="flex-wrap:wrap;">'
            + '<div class="pgto-info-col">'
            + '<div class="pgto-nome">' + p.pessoa + recebedorStr + '</div>'
            + '<div class="pgto-detalhe">' + eventoDesc + ' \u00b7 ' + p.data + '</div>'
            + (consumoStr ? '<div style="font-size:11px;color:#7C8782;margin-top:2px;">' + consumoStr + '</div>' : '')
            + '</div>'
            + '<span class="pgto-valor' + ((isPrescricao || isPendente) ? (isAdmin() ? ' prescrita' : ' por-confirmar') : '') + '">\u20ac' + p.valor.toFixed(2) + '</span>'
            + acoes
            + '</div>';
    }).join('');

    lista.innerHTML = filtersHtml + (filtrados.length === 0
        ? '<div class="contas-vazio">Nenhum resultado encontrado</div>'
        : itemsHtml);

    var totalFiltrado = filtrados.filter(function(p) { return p.tipo !== 'prescricao' && p.tipo !== 'pendente'; }).reduce(function(s, p) { return s + p.valor; }, 0);
    var totalGeral = basePagamentos.filter(function(p) { return p.tipo !== 'prescricao' && p.tipo !== 'pendente'; }).reduce(function(s, p) { return s + p.valor; }, 0);
    var isFiltered = _pgtoFilterPessoa || _pgtoFilterEvento;
    var showTotal = isFiltered ? totalFiltrado : totalGeral;
    var showCount = isFiltered ? filtrados.length : basePagamentos.length;
    resumo.innerHTML = '<div style="text-align:right;font-size:13px;color:#0E7A4F;padding:8px 0;font-weight:600;">Total' + (isFiltered ? ' filtrado' : ' recebido') + ': \u20ac' + showTotal.toFixed(2) + ' (' + showCount + ' pagamento' + (showCount !== 1 ? 's' : '') + ')</div>';
}

function editarPagamento(id) {
    const p = pagamentos.find(pg => pg.id === id);
    if (!p) return;
    const container = document.getElementById('pgto-item-' + id);
    if (!container) return;
    // Toggle edit row
    const existing = container.querySelector('.pgto-edit-row');
    if (existing) { existing.remove(); return; }
    const editRow = document.createElement('div');
    editRow.className = 'pgto-edit-row';
    editRow.innerHTML = `
        <label style="font-size:12px;color:#4A534E;white-space:nowrap;">Data:</label>
        <input type="text" id="pgto-edit-data-${id}" value="${p.data}" style="flex:1;" placeholder="dd/mm/aaaa, hh:mm">
        <button onclick="guardarEdicaoPgto(${id})" style="background:#0E7A4F;color:white;">✓</button>
        <button onclick="this.closest('.pgto-edit-row').remove()" class="secondary" style="padding:6px 8px;">✕</button>
    `;
    container.appendChild(editRow);
}

// ── Payment form ──

function renderPgtoForm() {
    const sel = document.getElementById('pgto-pessoa');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Quem pagou?</option>';
    const saldos = calcularSaldos();
    const pessoas = Object.keys(saldos).sort();
    pessoas.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p + (saldos[p].saldo > 0.005 ? ' (deve €' + saldos[p].saldo.toFixed(2) + ')' : ' ✅');
        sel.appendChild(opt);
    });
    if (current && sel.querySelector(`option[value="${CSS.escape(current)}"]`)) sel.value = current;
    atualizarPgtoForm();
}

function atualizarPgtoForm() {
    const eventoRow = document.getElementById('pgto-evento-row');
    if (!eventoRow) return;
    const info = document.getElementById('pgto-info');
    eventoRow.style.display = 'flex';
    renderPgtoEventoSelect();
    if (info) info.style.display = 'none';
}

function renderPgtoEventoSelect() {
    const pessoa = document.getElementById('pgto-pessoa').value;
    const sel = document.getElementById('pgto-evento');
    sel.innerHTML = '<option value="">-- Seleciona evento --</option>';
    if (!pessoa) return;

    const saldos = calcularSaldos();
    const pessoaSaldo = saldos[pessoa];
    if (!pessoaSaldo) return;

    const eventosOrdenados = pessoaSaldo.eventos.filter(e => e.restante > 0.005).sort((a, b) => {
        const evA = historico.find(h => h.id === a.eventoId);
        const evB = historico.find(h => h.id === b.eventoId);
        const dA = evA && evA.data ? evA.data.split('/').reverse().join('') : '0';
        const dB = evB && evB.data ? evB.data.split('/').reverse().join('') : '0';
        return dB.localeCompare(dA);
    });
    eventosOrdenados.forEach(e => {
        if (!podeRegistarDiretamente(pessoa, e.eventoId)) return;
        const ev = historico.find(h => h.id === e.eventoId);
        const dataStr = ev && ev.data ? ' · ' + ev.data : '';
        const opt = document.createElement('option');
        opt.value = e.eventoId;
        opt.textContent = `${comboLabel(e.descricao)}${dataStr} — €${e.restante.toFixed(2)}`;
        opt.dataset.valor = e.restante.toFixed(2);
        opt.dataset.eventoData = ev && ev.data ? ev.data : '';
        sel.appendChild(opt);
    });
}

function atualizarPgtoValorEvento() {
    const sel = document.getElementById('pgto-evento');
    const opt = sel.selectedOptions[0];
    const info = document.getElementById('pgto-info');
    const dataInput = document.getElementById('pgto-data');
    if (opt && opt.dataset.valor) {
        info.textContent = '💰 Valor: €' + parseFloat(opt.dataset.valor).toFixed(2);
        info.style.display = 'block';
        // Auto-fill date with event date
        if (opt.dataset.eventoData && dataInput) {
            dataInput.value = opt.dataset.eventoData;
        }
    } else {
        info.style.display = 'none';
    }
}

async function registarPagamento() {
    const pessoa = document.getElementById('pgto-pessoa').value;

    if (!pessoa) { mostrarPgtoMsg('⚠️ Seleciona quem pagou', false); return; }

    const selEvento = document.getElementById('pgto-evento');
    const eventoId = selEvento.value;
    if (!eventoId) { mostrarPgtoMsg('⚠️ Seleciona o evento', false); return; }
    if (!podeEditarPagamentoDoEvento(eventoId)) { mostrarPgtoMsg('⚠️ Sem permissão para registar pagamentos deste evento', false); return; }
    const valor = parseFloat(selEvento.selectedOptions[0].dataset.valor);

    // Check for duplicate: same pessoa + same eventoId already paid
    const existente = pagamentos.find(p => p.pessoa === pessoa && String(p.eventoId) === String(eventoId));
    if (existente) {
        mostrarPgtoMsg('⚠️ ' + pessoa + ' já tem um pagamento registado para este evento', false);
        return;
    }

    // Use user-provided date, fallback to now
    const dataInput = document.getElementById('pgto-data');
    const dataPgto = dataInput && dataInput.value.trim()
        ? dataInput.value.trim()
        : new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});

    const novoPgto = {
        id: nextId(),
        pessoa,
        valor,
        tipo: 'evento',
        eventoId: parseInt(eventoId),
        data: dataPgto
    };
    pagamentos.push(novoPgto);
    salvarPagamentos();
    const okSb = await sbGuardarPagamento(novoPgto);

    document.getElementById('pgto-evento').value = '';
    document.getElementById('pgto-data').value = '';
    document.getElementById('pgto-info').style.display = 'none';

    fecharFabPanel();
    renderContas();
    renderHistoricoDropdown();
    if (okSb) mostrarPgtoMsg('✅ Pagamento de €' + valor.toFixed(2) + ' registado para ' + pessoa, true);
}

// Marca a dívida como prescrita: deixa de contar como pendente (sem alerta constante),
// mas fica um registo (tipo 'prescricao' na tabela pagamentos) para aparecer discreto
// no histórico, só visível a quem devia e a quem era devido.
async function prescreverDivida() {
    const pessoa = document.getElementById('pgto-pessoa').value;
    if (!pessoa) { mostrarPgtoMsg('⚠️ Seleciona quem deve', false); return; }

    const selEvento = document.getElementById('pgto-evento');
    const eventoId = selEvento.value;
    if (!eventoId) { mostrarPgtoMsg('⚠️ Seleciona o evento', false); return; }
    if (!podeEditarPagamentoDoEvento(eventoId)) { mostrarPgtoMsg('⚠️ Sem permissão para editar dívidas deste evento', false); return; }
    const valor = parseFloat(selEvento.selectedOptions[0].dataset.valor);

    const existente = pagamentos.find(p => p.pessoa === pessoa && String(p.eventoId) === String(eventoId));
    if (existente) {
        mostrarPgtoMsg('⚠️ ' + pessoa + ' já tem um registo para este evento', false);
        return;
    }

    const ok = await mostrarModal({
        icon: '⌛',
        title: 'Prescrever dívida',
        msg: 'Confirmas que <strong>' + pessoa + '</strong> não vai pagar os €' + valor.toFixed(2) + ' em falta?<br><br>Deixa de aparecer como pendente, mas fica uma nota discreta no histórico.',
        confirmText: 'Prescrever',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;

    const dataInput = document.getElementById('pgto-data');
    const dataPresc = dataInput && dataInput.value.trim()
        ? dataInput.value.trim()
        : new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});

    const novaPresc = {
        id: nextId(),
        pessoa,
        valor,
        tipo: 'prescricao',
        eventoId: parseInt(eventoId),
        data: dataPresc
    };
    pagamentos.push(novaPresc);
    salvarPagamentos();
    const okSb = await sbGuardarPagamento(novaPresc);

    document.getElementById('pgto-evento').value = '';
    document.getElementById('pgto-data').value = '';
    document.getElementById('pgto-info').style.display = 'none';

    fecharFabPanel();
    renderContas();
    renderHistoricoDropdown();
    if (okSb) mostrarPgtoMsg('⌛ Dívida de ' + pessoa + ' prescrita', true);
}

function guardarEdicaoPgto(id) {
    const input = document.getElementById('pgto-edit-data-' + id);
    if (!input) return;
    const p = pagamentos.find(pg => pg.id === id);
    if (!p) return;
    if (!podeEditarPagamentoDoEvento(p.eventoId)) { mostrarMensagem('⚠️ Sem permissão para editar este pagamento', false); return; }
    p.data = input.value.trim() || p.data;
    salvarPagamentos();
    sbGuardarPagamento(p);
    renderContas();
}

async function removerPagamento(id) {
    const p = pagamentos.find(pg => pg.id === id);
    if (p && !podeEditarPagamentoDoEvento(p.eventoId)) { mostrarMensagem('⚠️ Sem permissão para remover este pagamento', false); return; }
    const isPrescricao = p && p.tipo === 'prescricao';
    const ok = await mostrarModal({
        icon: isPrescricao ? '⌛' : '💸',
        title: isPrescricao ? 'Anular prescrição' : 'Remover pagamento',
        msg: isPrescricao ? 'Tens a certeza que queres anular a prescrição desta dívida? Volta a aparecer como pendente.' : 'Tens a certeza que queres remover este pagamento?',
        confirmText: isPrescricao ? 'Anular' : 'Remover',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    pagamentos = pagamentos.filter(p => p.id !== id);
    salvarPagamentos();
    sbApagarPagamento(id);
    renderContas();
    renderHistoricoDropdown();
}

function mostrarPgtoMsg(msg, ok) {
    const div = document.getElementById('pgto-msg');
    if (!div) return;
    div.className = ok ? 'sucesso' : 'aviso';
    div.textContent = msg;
    setTimeout(() => { div.textContent = ''; div.className = ''; }, 3000);
}

/* ── PEDIDOS DE PAGAMENTO (declarados pelo utilizador, por confirmar) ──
   Quem deve uma dívida sua pode dizer "já paguei" — pendente ou já prescrita
   — mesmo sendo admin ou substituto do evento (ver podeRegistarDiretamente):
   ninguém confirma pagamentos a si mesmo só por ter permissões de gestão.
   Isso cria um pagamento tipo='pendente' que NÃO abate a dívida (ver
   calcularSaldos) até quem pagou a conta (ou o admin, como alternativa)
   confirmar (vira tipo='evento') ou rejeitar (é removido). Precisa da
   migração db/pagamentos-pendentes.sql — sem ela PAGAMENTOS_PENDENTE_COL
   fica false e os controlos escondem-se (volta ao registo direto). */

function refrescarInicioSeVisivel() {
    try { if (typeof renderInicio === 'function') renderInicio(); } catch(e) {}
}

async function declararPagamento(pessoa, eventoId, valor) {
    if (!PAGAMENTOS_PENDENTE_COL) { mostrarMensagem('⚠️ Funcionalidade indisponível — falta uma migração na BD', false); return; }
    if (!ehEu(pessoa)) { mostrarMensagem('⚠️ Só podes declarar os teus próprios pagamentos', false); return; }
    const jaPendente = pagamentos.find(p => p.tipo === 'pendente' && p.pessoa === pessoa && String(p.eventoId) === String(eventoId));
    if (jaPendente) { mostrarMensagem('⏳ Já enviaste este pedido — aguarda confirmação do admin.', false); return; }

    const ok = await mostrarModal({
        icon: '💸',
        title: 'Já pagaste?',
        msg: 'Confirmas que já pagaste os <strong>€' + valor.toFixed(2) + '</strong>?<br><br>Fica pendente até o admin confirmar — não é definitivo.',
        confirmText: 'Sim, já paguei',
        cancelText: 'Cancelar'
    });
    if (!ok) return;

    const novo = {
        id: nextId(),
        pessoa, valor, tipo: 'pendente',
        eventoId: parseInt(eventoId),
        data: new Date().toLocaleDateString('pt-PT', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}),
        declaradoPor: emailSessao()
    };
    pagamentos.push(novo);
    salvarPagamentos();
    const okSb = await sbGuardarPagamento(novo);
    renderContas();
    refrescarInicioSeVisivel();
    sbNotificarPagamentoDeclarado(pessoa, novo.eventoId, valor);  // fire-and-forget, não bloqueia UI
    if (okSb) mostrarMensagem('✓ Pedido enviado — aguarda confirmação do admin.', true);
}

// Anula a própria declaração (antes de o admin decidir). Só quem a fez pode.
async function cancelarDeclaracaoPagamento(id) {
    const p = pagamentos.find(pg => pg.id === id);
    if (!p || p.tipo !== 'pendente' || p.declaradoPor !== emailSessao()) return;
    pagamentos = pagamentos.filter(pg => pg.id !== id);
    salvarPagamentos();
    await sbApagarPagamento(id);
    renderContas();
    refrescarInicioSeVisivel();
    mostrarMensagem('Pedido cancelado', true);
}

// Pedidos que ESTE utilizador pode agir: o admin (e o substituto, via
// podeEditarPagamentoDoEvento) vê todos; o pagador só os do(s) evento(s) que
// ele próprio pagou.
function pedidosPagamentoPendentes() {
    return pagamentos.filter(p => p.tipo === 'pendente' && podeConfirmarPedidosDoEvento(p.eventoId));
}

// Admin, substituto ou o pagador do evento confirmam um pedido: grava como
// pagamento real (tipo='evento') e, se existia uma prescrição anterior para
// o mesmo evento/pessoa, remove-a — o utilizador estava a corrigi-la.
async function confirmarPedidoPagamento(id) {
    const p = pagamentos.find(pg => pg.id === id);
    if (!p || p.tipo !== 'pendente') return;
    if (!podeConfirmarPedidosDoEvento(p.eventoId)) { mostrarMensagem('⚠️ Sem permissão para confirmar este pedido', false); return; }
    const ok = await mostrarModal({
        icon: '✅',
        title: 'Confirmar pagamento',
        msg: 'Confirmas que <strong>' + p.pessoa + '</strong> pagou os €' + p.valor.toFixed(2) + '?',
        confirmText: 'Confirmar',
        cancelText: 'Cancelar'
    });
    if (!ok) return;

    const presc = pagamentos.find(pg => pg.tipo === 'prescricao' && pg.pessoa === p.pessoa && String(pg.eventoId) === String(p.eventoId));
    if (presc) {
        pagamentos = pagamentos.filter(pg => pg.id !== presc.id);
        sbApagarPagamento(presc.id);
    }
    p.tipo = 'evento';
    p.declaradoPor = null;
    salvarPagamentos();
    await sbConfirmarPedidoPagamento(p.id);
    renderContas();
    renderHistoricoDropdown();
    refrescarInicioSeVisivel();
    mostrarMensagem('✓ Pagamento de ' + p.pessoa + ' confirmado', true);
}

// Admin, substituto ou o pagador do evento rejeitam: a dívida volta a ficar
// como estava antes (pendente, ou prescrita se já o era — essa não é tocada).
async function rejeitarPedidoPagamento(id) {
    const p = pagamentos.find(pg => pg.id === id);
    if (!p || p.tipo !== 'pendente') return;
    if (!podeConfirmarPedidosDoEvento(p.eventoId)) { mostrarMensagem('⚠️ Sem permissão para rejeitar este pedido', false); return; }
    const ok = await mostrarModal({
        icon: '❌',
        title: 'Rejeitar pedido',
        msg: 'Rejeitar o pedido de pagamento de <strong>' + p.pessoa + '</strong> (€' + p.valor.toFixed(2) + ')?<br><br>A dívida volta a ficar por confirmar.',
        confirmText: 'Rejeitar',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    pagamentos = pagamentos.filter(pg => pg.id !== id);
    salvarPagamentos();
    await sbApagarPagamento(id);
    renderContas();
    refrescarInicioSeVisivel();
    mostrarMensagem('Pedido rejeitado', true);
}

// Calculate final amounts for any event
// Distribui o total pelos não-pagadores usando o método Hamilton (maior resto).
// Resultado: soma dos valores == Math.round(sum_bruta * 100)/100
// Determinístico: mesmos dados → mesmo resultado sempre.
function calcularDivisaoHamilton(contaFinalRaw, pagador) {
    const entries = Object.entries(contaFinalRaw)
        .filter(([p, v]) => p !== pagador && v > 0.005);
    if (!entries.length) return {};

    // Total em cêntimos — arredondamento da soma, não soma dos arredondamentos
    const totalCents = Math.round(entries.reduce((s, [, v]) => s + v, 0) * 100);

    const items = entries.map(([pessoa, valor]) => {
        const cents = valor * 100;
        const base  = Math.floor(cents);
        return { pessoa, base, frac: cents - base };
    });

    let resto = totalCents - items.reduce((s, x) => s + x.base, 0);

    // Maior fração primeiro; desempate alfabético → determinístico
    items.sort((a, b) => b.frac - a.frac || a.pessoa.localeCompare(b.pessoa));
    for (let i = 0; i < items.length && resto > 0; i++, resto--) items[i].base++;

    const result = {};
    items.forEach(x => { result[x.pessoa] = x.base / 100; });
    return result;
}

function calcularContaFinalEvento(ev) {
    const totalMesa = (ev.ordens || []).reduce((sum, o) => sum + o.precoTotal, 0);
    const fatura = ev.totalFatura || totalMesa;
    const racio = totalMesa > 0 ? fatura / totalMesa : 1;

    const setPessoas = new Set();
    (ev.ordens || []).forEach(o => o.amigos.forEach(a => setPessoas.add(a)));
    (ev.ofertas || []).forEach(o => { setPessoas.add(o.quem); o.para.forEach(p => setPessoas.add(p)); });

    const contaBruta = {};
    setPessoas.forEach(p => contaBruta[p] = 0);
    (ev.ordens || []).forEach(o => {
        const share = o.precoTotal / o.amigos.length;
        o.amigos.forEach(a => { contaBruta[a] = (contaBruta[a] || 0) + share; });
    });

    // Saldo ofertas
    const saldo = {};
    (ev.ofertas || []).forEach(oferta => {
        if (!saldo[oferta.quem]) saldo[oferta.quem] = 0;
        saldo[oferta.quem] += oferta.precoTotal;
        const share = oferta.precoTotal / oferta.para.length;
        oferta.para.forEach(p => {
            if (!saldo[p]) saldo[p] = 0;
            saldo[p] -= share;
        });
    });

    const contaLiquida = {};
    setPessoas.forEach(p => {
        contaLiquida[p] = (contaBruta[p] || 0) + (saldo[p] || 0);
    });

    const isMatch = Math.abs(fatura - totalMesa) < 0.01;
    if (isMatch || totalMesa === 0) return contaLiquida;

    const diff = fatura - totalMesa;
    const base = diff < 0 ? contaLiquida : contaBruta;
    const totalBase = Object.values(base).reduce((a, b) => a + b, 0);
    const contaFinal = {};
    setPessoas.forEach(p => {
        const part = totalBase > 0 ? (base[p] / totalBase) : 0;
        const ajuste = part * diff;
        contaFinal[p] = contaLiquida[p] + ajuste;
    });
    return contaFinal;
}

// ── EDIT ORDEM INLINE ──────────────────────────────────────────────────────
function toggleEditOrdem(id) {
    const ordemDiv = document.getElementById('ordem-' + id);
    const existing = ordemDiv.querySelector('.ordem-edit-panel');
    if (existing) { existing.remove(); return; }

    const ordem = estado.ordens.find(o => o.id === id);
    if (!ordem) return;

    const panel = document.createElement('div');
    panel.className = 'ordem-edit-panel';
    panel.style.width = '100%';

    // Item select
    const selItem = document.createElement('select');
    selItem.style.width = '100%';
    selItem.innerHTML = Object.keys(menu).sort().map(k =>
        `<option value="${k}" ${k === ordem.item ? 'selected' : ''}>${k} (€${menu[k].toFixed(2)})</option>`
    ).join('');
    panel.appendChild(selItem);

    // Qtd select
    const selQtd = document.createElement('select');
    selQtd.style.width = '80px';
    for (let i = 1; i <= 10; i++) {
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = i;
        if (i === ordem.quantidade) opt.selected = true;
        selQtd.appendChild(opt);
    }
    panel.appendChild(selQtd);

    // Amigos grid
    const label = document.createElement('div');
    label.textContent = 'Quem comeu/bebeu?';
    label.style.cssText = 'font-size:12px;color:#5B6661;margin:8px 0 4px;';
    panel.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'amigos-grid';
    const selAmigos = new Set(ordem.amigos);
    amigos.forEach(a => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'amigo-btn' + (selAmigos.has(a) ? ' selected' : '');
        btn.textContent = a;
        btn.onclick = (e) => {
            e.preventDefault();
            btn.classList.toggle('selected');
            selAmigos.has(a) ? selAmigos.delete(a) : selAmigos.add(a);
        };
        grid.appendChild(btn);
    });
    panel.appendChild(grid);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'ordem-edit-actions';

    const btnGuardar = document.createElement('button');
    btnGuardar.textContent = '✓ Guardar';
    btnGuardar.onclick = () => {
        if (selAmigos.size === 0) { alert('Seleciona pelo menos um amigo'); return; }
        const evAtual = historico.find(h => h.id === eventoAtualId);
        const podeTudo = podeEditarEventoAtual();
        if (!podeTudo && !ehOrdemPropria(ordem, evAtual)) {
            mostrarMensagem('⚠️ Só podes editar as tuas próprias ordens', false);
            return;
        }
        const idx = estado.ordens.findIndex(o => o.id === id);
        const novoItem = selItem.value;
        const novaQtd = parseInt(selQtd.value);
        estado.ordens[idx] = {
            ...estado.ordens[idx],
            item: novoItem,
            quantidade: novaQtd,
            precoUnitario: menu[novoItem],
            precoTotal: menu[novoItem] * novaQtd,
            amigos: Array.from(selAmigos)
        };
        if (podeTudo) {
            salvarNoLocalStorage();
        } else {
            _sincronizarOrdensNoHistorico();
            sbAtualizarOrdemPropria(estado.ordens[idx]);
        }
        atualizarUI();
        mostrarMensagem('✓ Ordem atualizada!', true);
    };

    const btnCancelar = document.createElement('button');
    btnCancelar.textContent = '✕ Cancelar';
    btnCancelar.className = 'secondary';
    btnCancelar.onclick = () => panel.remove();

    actions.appendChild(btnGuardar);
    actions.appendChild(btnCancelar);
    panel.appendChild(actions);

    ordemDiv.appendChild(panel);
}

// ── CONFIGS ────────────────────────────────────────────────────────────────
function toggleConfig() {
    const body = document.getElementById('config-body');
    const arrow = document.getElementById('config-arrow');
    const visible = body.style.display !== 'none';
    body.style.display = visible ? 'none' : 'block';
    arrow.textContent = visible ? '▼' : '▲';
}

function toggleGuardar() {
    const body = document.getElementById('guardar-body');
    const arrow = document.getElementById('guardar-arrow');
    const visible = body.style.display !== 'none';
    body.style.display = visible ? 'none' : 'block';
    arrow.textContent = visible ? '▼' : '▲';
}

function carregarConfigs() {
    // Legacy — configs now live per-event in historico.
    // Nothing to do here; amigos and menu are loaded via carregarEvento().
}

function guardarConfigs() {
    // Save amigos and menu into current event in historico
    salvarNoLocalStorage();
}

async function limparConfigs() {
    const ok = await mostrarModal({
        icon: '🗑️',
        title: 'Limpar configurações',
        msg: 'Remover todos os amigos e itens do menu?',
        confirmText: 'Limpar',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    amigos = [];
    menu = {};
    guardarConfigs();
    renderConfigAmigos();
    renderConfigMenu();
    renderDropdownItens();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
    mostrarMensagem('✓ Configurações limpas', true);
}

function renderConfigAmigos() {
    const div = document.getElementById('config-amigos-lista');
    const emUso = new Set();
    estado.ordens.forEach(o => o.amigos.forEach(a => emUso.add(a)));
    estado.ofertas.forEach(o => { emUso.add(o.quem); o.para.forEach(a => emUso.add(a)); });

    div.innerHTML = amigos.map((a, i) => {
        // Corrigir: só mostrar botão eliminar se NÃO estiver em uso
        const usado = emUso.has(a);
        const editId = `edit-amigo-${i}`;
        return `
        <div class="config-item" id="cfg-amigo-${i}">
            <span>${a}${ehEu(a) ? ' <span style="font-size:10px;color:#0E7A4F;font-weight:600;">(tu)</span>' : ''}${(isAdmin() && amigoUsers[a]) ? ` <span style="font-size:10px;color:#7C8782;">· ${amigoUsers[a]}</span>` : ''}</span>
            <button class="secondary" style="padding:4px 8px;font-size:12px;" onclick="toggleEditAmigo(${i})">✏️</button>
            ${!usado ? `<button class="danger" style="padding:4px 8px;font-size:12px;" onclick="removerAmigo(${i})">×</button>` : ''}
        </div>
        <div class="config-edit-row" id="${editId}" style="display:none;">
            <input type="text" id="edit-amigo-val-${i}" value="${a}" style="flex:1;">
            <button onclick="guardarEdicaoAmigo(${i})">✓</button>
            <button class="secondary" onclick="toggleEditAmigo(${i})">✕</button>
        </div>`;
    }).join('');
    renderSugestoesAmigos();
}

// Sugestões para o campo "adicionar amigo": amigos de eventos anteriores que
// ainda não estão neste evento, com os que têm conta no topo. Mantém a grafia
// canónica para evitar incoerências (ex.: "João Matias" em vez de "J Matias").
function renderSugestoesAmigos() {
    const dl = document.getElementById('amigos-sugeridos');
    if (!dl) return;
    const jaTem = new Set(amigos);
    const candidatos = amigosAgregadoGlobal().filter(a => !jaTem.has(a));
    candidatos.sort((a, b) => {
        const ca = amigoUsers[a] ? 0 : 1, cb = amigoUsers[b] ? 0 : 1;
        return ca - cb || a.localeCompare(b, 'pt');
    });
    const esc = s => String(s).replace(/"/g, '&quot;');
    dl.innerHTML = candidatos.map(a => {
        const lbl = amigoUsers[a]
            ? (isAdmin() ? `✓ conta · ${amigoUsers[a]}` : '✓ tem conta')
            : 'de eventos anteriores';
        return `<option value="${esc(a)}" label="${esc(lbl)}"></option>`;
    }).join('');
}

function toggleEditAmigo(i) {
    const row = document.getElementById(`edit-amigo-${i}`);
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
}

function guardarEdicaoAmigo(i) {
    const novoNome = document.getElementById(`edit-amigo-val-${i}`).value.trim();
    if (!novoNome) return;
    const nomeAntigo = amigos[i];
    if (novoNome === nomeAntigo) { toggleEditAmigo(i); return; }
    if (amigos.includes(novoNome)) { alert('Já existe um amigo com esse nome'); return; }
    // Cascade update ordens e ofertas
    estado.ordens.forEach(o => {
        o.amigos = o.amigos.map(a => a === nomeAntigo ? novoNome : a);
    });
    estado.ofertas.forEach(o => {
        if (o.quem === nomeAntigo) o.quem = novoNome;
        o.para = o.para.map(a => a === nomeAntigo ? novoNome : a);
    });
    // Update pagador if renamed
    if (estado.pagador === nomeAntigo) estado.pagador = novoNome;
    amigos[i] = novoNome;
    guardarConfigs();
    salvarNoLocalStorage();
    renderConfigAmigos();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
    atualizarUI();
    mostrarMensagem(`✓ "${nomeAntigo}" renomeado para "${novoNome}"`, true);
}

function adicionarAmigo() {
    const input = document.getElementById('novo-amigo');
    let nome = input.value.trim();
    if (!nome) return;
    // Reutilizar a grafia canónica de um amigo já conhecido (evita "samuel"/"Samuel").
    const match = amigosAgregadoGlobal().find(a => a.toLowerCase() === nome.toLowerCase());
    if (match) nome = match;
    if (amigos.some(a => a.toLowerCase() === nome.toLowerCase())) { alert('Amigo já existe'); return; }
    amigos.push(nome);
    guardarConfigs();
    renderConfigAmigos();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
    input.value = '';
}

async function removerAmigo(idx) {
    const ok = await mostrarModal({
        icon: '👤',
        title: 'Remover amigo',
        msg: `Remover "${amigos[idx]}"?`,
        confirmText: 'Remover',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    amigos.splice(idx, 1);
    guardarConfigs();
    renderConfigAmigos();
    renderAmigosBotoes();
    renderOfertaDropdowns();
    renderOfertaAmigos();
    renderPagadorSelect();
}

function renderConfigMenu() {
    const div = document.getElementById('config-menu-lista');
    const itensEmUso = new Set(estado.ordens.map(o => o.item));

    div.innerHTML = Object.keys(menu).sort().map((item, i) => {
        // Corrigir: só mostrar botão eliminar se NÃO estiver em uso
        const usado = itensEmUso.has(item);
        const safeVal = item.replace(/"/g, '&quot;');
        return `
        <div class="config-item" id="cfg-menu-${i}">
            <span>${item}</span>
            <span class="preco-tag">€${menu[item].toFixed(2)}</span>
            <button class="secondary" style="padding:4px 8px;font-size:12px;" onclick="toggleEditMenu(${i})">✏️</button>
            ${!usado ? `<button class="danger" style="padding:4px 8px;font-size:12px;" onclick="removerItemMenu(${i})">×</button>` : ''}
        </div>
        <div class="config-edit-row" id="edit-menu-${i}" style="display:none;">
            <input type="text" id="edit-menu-nome-${i}" value="${safeVal}" style="flex:2;">
            <input type="number" id="edit-menu-preco-${i}" value="${menu[item].toFixed(2)}" min="0" step="0.10" style="flex:1;min-width:55px;">
            <button onclick="guardarEdicaoMenu(${i})">✓</button>
            <button class="secondary" onclick="toggleEditMenu(${i})">✕</button>
        </div>`;
    }).join('');
}

function toggleEditMenu(i) {
    const row = document.getElementById('edit-menu-' + i);
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
}

function guardarEdicaoMenu(i) {
    const nomeAntigo = Object.keys(menu).sort()[i];
    const novoNome = document.getElementById('edit-menu-nome-' + i).value.trim();
    const novoPreco = parseFloat(document.getElementById('edit-menu-preco-' + i).value);
    if (!novoNome) { alert('Nome não pode estar vazio'); return; }
    if (isNaN(novoPreco) || novoPreco <= 0) { alert('Preço inválido'); return; }
    estado.ordens.forEach(o => {
        if (o.item === nomeAntigo) {
            o.item = novoNome;
            o.precoUnitario = novoPreco;
            o.precoTotal = novoPreco * o.quantidade;
        }
    });
    estado.ofertas.forEach(o => {
        if (o.item === nomeAntigo) {
            o.item = novoNome;
            o.precoUnitario = novoPreco;
            o.precoTotal = novoPreco * o.quantidade;
        }
    });
    delete menu[nomeAntigo];
    menu[novoNome] = novoPreco;
    guardarConfigs();
    salvarNoLocalStorage();
    renderConfigMenu();
    renderDropdownItens();
    renderOfertaDropdowns();
    atualizarUI();
    mostrarMensagem('✓ Menu atualizado', true);
}

async function removerItemMenu(i) {
    const nome = Object.keys(menu).sort()[i];
    const ok = await mostrarModal({
        icon: '🍽️',
        title: 'Remover item',
        msg: `Remover "${nome}" do menu?`,
        confirmText: 'Remover',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    delete menu[nome];
    guardarConfigs();
    renderConfigMenu();
    renderDropdownItens();
    renderOfertaDropdowns();
}

function adicionarItemMenu() {
    const nome = document.getElementById('novo-item-nome').value.trim();
    const preco = parseFloat(document.getElementById('novo-item-preco').value);
    if (!nome) { alert('Insere o nome do item'); return; }
    if (isNaN(preco) || preco <= 0) { alert('Insere um preço válido'); return; }
    menu[nome] = preco;
    guardarConfigs();
    renderConfigMenu();
    renderDropdownItens();
    renderOfertaDropdowns();
    document.getElementById('novo-item-nome').value = '';
    document.getElementById('novo-item-preco').value = '';
}




function importarExcel() {
    const input = document.getElementById('input-xlsx');
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const wb = XLSX.read(e.target.result, {type: 'array'});

            // Sheet "Amigos" — column A
            const wsAmigos = wb.Sheets['Amigos'];
            if (wsAmigos) {
                const rows = XLSX.utils.sheet_to_json(wsAmigos, {header:1});
                amigos = rows.slice(1).map(r => r[0]).filter(v => v && String(v).trim());
            }

            // Sheet "Menu" — column A nome, column B preço
            const wsMenu = wb.Sheets['Menu'];
            if (wsMenu) {
                const rows = XLSX.utils.sheet_to_json(wsMenu, {header:1});
                menu = {};
                rows.slice(1).forEach(r => {
                    const nome = r[0] ? String(r[0]).trim() : null;
                    const preco = parseFloat(r[1]);
                    if (nome && !isNaN(preco) && preco > 0) menu[nome] = preco;
                });
            }

            guardarConfigs();
            renderConfigAmigos();
            renderConfigMenu();
            renderDropdownItens();
            renderAmigosBotoes();
            renderOfertaDropdowns();
            renderOfertaAmigos();
            renderPagadorSelect();
            mostrarMensagem('✓ ' + amigos.length + ' amigos e ' + Object.keys(menu).length + ' itens importados', true);
        } catch(err) {
            mostrarMensagem('❌ Erro ao importar Excel', false);
            console.error(err);
        }
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
}

function toggleAjuda() {
    const body = document.getElementById('ajuda-body');
    const arrow = document.getElementById('ajuda-arrow');
    const visible = body.style.display !== 'none';
    body.style.display = visible ? 'none' : 'block';
    arrow.textContent = visible ? '▼' : '▲';
}

/* ── SUPABASE ───────────────────────────────── */
const SB_URL = 'https://gjweqwfbnkgnibhajldc.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';
const ADMIN_EMAIL = 'diogo.andre.f.silva@gmail.com';
// Par de chaves só para notificações Web Push (não é a chave do Supabase).
// A privada vive só como secret da Edge Function push-notificar.
const VAPID_PUBLIC_KEY = 'BFiwf_z5NJzkXFP6gzxS_naH9cNC2MfCEmejJf32MID8Y_1i49cb8sGINYhH-aFAZmFQLf3V__2ZyeotQIZYQ0U';

let _sbSession = null;
let amigoUsers = {};          // equivalência { nomeAmigo: email }  (gerida só pelo admin)
let _allowedUsersCache = [];  // emails com acesso (para dropdowns do admin)

/* ── SESSÃO: refresh automático do token (o access_token expira em ~1h) ──
   Sem isto a app voltava a pedir login a cada hora. Padrão portado da FestasBV. */
const SESSION_KEY = 'sb_session';
let _refreshing = null;       // evita refreshes concorrentes (refresh_token é de uso único)

function sbSaveSession(s) {
    _sbSession = s;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch(e) {}
}
function tokenQuaseExpirado() {
    if (!_sbSession) return false;
    if (!_sbSession.expires_at) return true;   // sessões antigas sem expires_at: assumir que pode estar expirado
    return (_sbSession.expires_at - Date.now() / 1000) < 120;
}
async function sbRefresh() {
    if (!_sbSession || !_sbSession.refresh_token) return false;
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
        try {
            const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: _sbSession.refresh_token })
            });
            if (!r.ok) return false;
            const d = await r.json();
            sbSaveSession({
                access_token: d.access_token,
                refresh_token: d.refresh_token || _sbSession.refresh_token,
                expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
                user: d.user || _sbSession.user
            });
            return true;
        } catch(e) { return false; }
    })();
    const ok = await _refreshing;
    _refreshing = null;
    return ok;
}
async function sbEnsureFresh() {
    if (_sbSession && _sbSession.refresh_token && tokenQuaseExpirado()) await sbRefresh();
}
// fetch para o REST: garante token fresco e, se ainda assim vier 401, faz refresh + 1 retry
async function sbFetch(url, opt) {
    opt = opt || {};
    // Em modo "ver como" o token continua a ser o do admin: uma escrita passaria
    // e ficaria gravada em nome de outra pessoa. Corta-se aqui, num sítio só,
    // em vez de andar a semear guardas por cada função que grava.
    const _metodo = (opt.method || 'GET').toUpperCase();
    if (typeof verComoAtivo === 'function' && verComoAtivo() && _metodo !== 'GET' && _metodo !== 'HEAD') {
        mostrarMensagem('👁️ Modo "ver como": nada é gravado. Sai do modo para editar.', false);
        return new Response('[]', { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    await sbEnsureFresh();
    opt.headers = Object.assign({}, opt.headers, { 'Authorization': `Bearer ${_sbSession?.access_token || SB_KEY}` });
    let r = await fetch(url, opt);
    if (r.status === 401 && _sbSession && _sbSession.refresh_token) {
        if (await sbRefresh()) {
            opt.headers['Authorization'] = `Bearer ${_sbSession.access_token}`;
            r = await fetch(url, opt);
        }
    }
    return r;
}
// Refresh preventivo: a cada 10 min e sempre que a PWA volta ao ecrã
setInterval(() => { sbEnsureFresh(); }, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sbEnsureFresh(); });

/* ── PERMISSÕES ──────────────────────────────── */
// Email da conta com sessão iniciada — o real, sempre, mesmo em modo "ver como".
function emailSessao() {
    return (_sbSession && _sbSession.user && _sbSession.user.email)
        ? _sbSession.user.email.toLowerCase() : null;
}
// Email que a INTERFACE usa. Em modo "ver como" é o do utilizador simulado: é
// daqui que saem isAdmin()/ehEu()/meusAmigos(), ou seja, tudo o que decide o que
// aparece no ecrã. Ver a secção "VER COMO" mais abaixo.
function emailAtual() { return _verComo || emailSessao(); }
function isAdmin() { return emailAtual() === ADMIN_EMAIL.toLowerCase(); }
// Sou mesmo o admin (ignorando o "ver como")? É o que permite sair do modo.
function isAdminReal() { return emailSessao() === ADMIN_EMAIL.toLowerCase(); }

// É o utilizador o substituto nomeado para este evento?
function ehSubstitutoDe(ev) {
    const e = emailAtual();
    return !!(ev && ev.substituto && e && ev.substituto.toLowerCase() === e);
}
// Pode editar este evento (ordens, ofertas, fatura)?
function podeEditarEvento(ev) { return isAdmin() || ehSubstitutoDe(ev); }
function podeEditarEventoAtual() {
    return podeEditarEvento(historico.find(h => h.id === eventoAtualId));
}
// Convocado (não admin/substituto) pode adicionar UMA ordem própria a este
// evento? Só se: o evento está em aberto (sem fatura), a migração
// db/ordens-proprias.sql já correu (senão o servidor recusa a escrita), e a
// pessoa está na lista de convocados do evento.
function podeAdicionarOrdemPropria(ev) {
    if (!ev || ev.totalFatura || !ORDENS_CRIADO_POR_COL) return false;
    const meus = meusAmigos();
    if (!meus.length) return false;
    return (ev.amigos || []).some(a => meus.includes(a));
}
// Esta ordem concreta foi criada por mim (via podeAdicionarOrdemPropria) e o
// evento continua em aberto? É o que autoriza editar/apagar só ESTA ordem.
function ehOrdemPropria(ordem, ev) {
    return !!(ordem && ordem.criadoPor && ordem.criadoPor === emailSessao() && ev && !ev.totalFatura);
}
// Eventos delegados a este utilizador
function eventosDelegados() {
    const e = emailAtual();
    if (!e) return [];
    return historico.filter(ev => (ev.substituto || '').toLowerCase() === e);
}
// Pode registar/editar pagamentos de um dado evento?
function podeEditarPagamentoDoEvento(eventoId) {
    if (isAdmin()) return true;
    const ev = historico.find(h => String(h.id) === String(eventoId));
    return ehSubstitutoDe(ev);
}
// Sou o pagador (tesoureiro) deste evento? É quem levou o dinheiro à mesa —
// diferente do substituto (nomeado pelo admin para editar o evento todo).
function ehPagadorDoEvento(eventoId) {
    const ev = historico.find(h => String(h.id) === String(eventoId));
    return !!(ev && ev.pagador && ehEu(ev.pagador));
}
// Pode marcar esta dívida como paga diretamente (sem pedido pendente)? Ter
// permissão de admin/substituto no evento não chega quando a dívida é a
// própria — mesmo o admin tem de pedir "Já paguei?" e deixar quem pagou a
// conta confirmar, para não se auto-confirmar pagamentos a si mesmo.
function podeRegistarDiretamente(pessoa, eventoId) {
    return podeEditarPagamentoDoEvento(eventoId) && !(ehEu(pessoa) && PAGAMENTOS_PENDENTE_COL);
}
// Pode confirmar/rejeitar pedidos de pagamento deste evento? Admin e
// substituto (via podeEditarPagamentoDoEvento) sempre; o pagador só para os
// pedidos DESTE evento — não ganha acesso aos outros.
function podeConfirmarPedidosDoEvento(eventoId) {
    return podeEditarPagamentoDoEvento(eventoId) || ehPagadorDoEvento(eventoId);
}
// Tem permissão para registar algum pagamento (admin ou tem eventos delegados)?
function podeRegistarPagamentos() { return isAdmin() || eventosDelegados().length > 0; }
// É a conta do utilizador atual equivalente a este amigo?
function ehEu(amigo) {
    const e = emailAtual();
    return !!(e && amigoUsers[amigo] && amigoUsers[amigo].toLowerCase() === e);
}
// Todos os nomes de amigo associados à conta atual (próprio + eventuais nomes extra mapeados ao mesmo email)
function meusAmigos() {
    const e = emailAtual();
    if (!e) return [];
    return Object.keys(amigoUsers).filter(a => (amigoUsers[a] || '').toLowerCase() === e);
}
// Aviso quando um não-admin ainda não tem nome associado (senão veria tudo vazio sem perceber porquê)
function _avisoSemAmigo() {
    return '<div class="contas-vazio">A tua conta ainda não está associada a nenhum nome. Pede ao administrador para te associar nas Configurações.</div>';
}

/* ── VER COMO (só admin) ──────────────────────────────────────────────────
   Serve para conferir o que uma pessoa vê sem lhe pedir o telemóvel. Troca
   apenas a IDENTIDADE do ecrã (emailAtual): a sessão e o token continuam a ser
   os do admin, logo os dados em memória são os mesmos — o que muda são os
   filtros de visibilidade, que é exatamente onde estão as diferenças a validar.
   Nota: o admin recebe do servidor tudo (RLS), portanto isto simula fielmente o
   que a app ESCONDE a cada um, não o que o servidor lhe recusaria.
   Duas salvaguardas: o modo vive em sessionStorage (sobrevive a um reload da
   PWA, morre ao fechar o separador) e toda a escrita no servidor fica bloqueada
   (ver sbFetch), para nunca gravar seja o que for em nome de outra pessoa. */
const VERCOMO_KEY = 'sb_ver_como';
let _verComo = null;   // email a simular; null = eu próprio

function verComoAtivo() { return !!_verComo; }

// Identidades simuláveis: uma por email conhecido, com o(s) nome(s) de amigo
// associados. Inclui contas autorizadas ainda sem equivalência (aparecem só com
// o email) — são precisamente as que costumam ver a app "vazia".
function verComoCandidatos() {
    const porEmail = {};
    Object.keys(amigoUsers).forEach(a => {
        const e = (amigoUsers[a] || '').toLowerCase();
        if (!e) return;
        (porEmail[e] = porEmail[e] || []).push(a);
    });
    _allowedUsersCache.forEach(e => {
        const k = (e || '').toLowerCase();
        if (k) porEmail[k] = porEmail[k] || [];
    });
    return Object.keys(porEmail).sort()
        .map(e => ({ email: e, nome: porEmail[e].join(' / ') }));
}
function verComoNome(email) {
    const c = verComoCandidatos().find(x => x.email === email);
    return (c && c.nome) ? c.nome : (email || '');
}

function entrarVerComo(email) {
    if (!isAdminReal()) return;
    email = (email || '').trim().toLowerCase();
    if (!email || email === ADMIN_EMAIL.toLowerCase()) { sairVerComo(); return; }
    _verComo = email;
    try { sessionStorage.setItem(VERCOMO_KEY, email); } catch(e) {}
    fecharEquivalencias();
    fecharAdmin();
    fecharDefinicoes();
    verComoAplicar();
    mostrarMensagem('👁️ A ver a app como ' + verComoNome(email), true);
}

function sairVerComo() {
    const estava = _verComo;
    _verComo = null;
    try { sessionStorage.removeItem(VERCOMO_KEY); } catch(e) {}
    verComoAplicar();
    if (estava) {
        sbVerificarPedidos();   // repõe o sino de pedidos, escondido durante o modo
        mostrarMensagem('✓ De volta à tua conta', true);
    }
}

// Repõe o ecrã inteiro com a identidade em vigor. Volta sempre ao início: o
// separador onde se estava pode nem existir para a pessoa simulada.
function verComoAplicar() {
    renderVerComoBanner();
    if (verComoAtivo()) {
        const b = document.getElementById('admin-badge');
        if (b) b.style.display = 'none';
    }
    try {
        renderHistoricoDropdown();
        renderConfigAmigos();
        atualizarUI();
        atualizarNavBadge();
        mudarPagina('inicio');
    } catch(e) { console.error('ver como:', e); }
}

function renderVerComoBanner() {
    const bar = document.getElementById('vercomo-bar');
    if (!bar) return;
    if (!verComoAtivo()) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        document.body.classList.remove('com-vercomo');
        return;
    }
    const nome = verComoNome(_verComo);
    bar.innerHTML = '<span class="vercomo-txt">👁️ A ver como <b>' + nome + '</b>'
        + (nome !== _verComo ? '<span class="vercomo-email">' + _verComo + '</span>' : '')
        + '</span><button onclick="sairVerComo()">Sair</button>';
    bar.style.display = 'flex';
    document.body.classList.add('com-vercomo');
}

// Dropdown no painel de definições do admin.
function renderVerComoSelect() {
    const sel = document.getElementById('vercomo-sel');
    if (!sel) return;
    const cands = verComoCandidatos().filter(c => c.email !== ADMIN_EMAIL.toLowerCase());
    if (!cands.length) {
        sel.innerHTML = '<option value="">— ainda não há outras contas —</option>';
        sel.disabled = true;
        return;
    }
    sel.disabled = false;
    sel.innerHTML = ['<option value="">— escolher pessoa —</option>'].concat(
        cands.map(c => '<option value="' + c.email + '">'
            + (c.nome ? c.nome + ' · ' + c.email : c.email) + '</option>')
    ).join('');
}

// Chamado depois do arranque: um reload da PWA não deve tirar o admin do modo
// (é preciso para testar precisamente o que acontece ao recarregar).
function verComoRestaurar() {
    if (!isAdminReal()) return;
    let guardado = null;
    try { guardado = sessionStorage.getItem(VERCOMO_KEY); } catch(e) {}
    if (!guardado || guardado === ADMIN_EMAIL.toLowerCase()) return;
    _verComo = guardado.toLowerCase();
    verComoAplicar();
}

/* ── AGREGAÇÃO GLOBAL (menu e amigos de todos os eventos) ── */
// Menu por defeito = todos os artigos de todos os eventos (ordem cronológica),
// mantendo, nos repetidos, o preço do evento mais recente.
function menuAgregadoGlobal() {
    const m = {};
    historico.forEach(ev => {
        (ev.ordens || []).forEach(o => { if (o.item && o.precoUnitario > 0) m[o.item] = o.precoUnitario; });
        (ev.ofertas || []).forEach(o => { if (o.item && o.precoUnitario > 0) m[o.item] = o.precoUnitario; });
        if (ev.menu) Object.keys(ev.menu).forEach(it => { if (ev.menu[it] > 0) m[it] = ev.menu[it]; });
    });
    return m;
}
// Amigos por defeito = todos os que existam em algum evento anterior.
function amigosAgregadoGlobal() {
    const vistos = new Set(); const lista = [];
    const add = a => { if (a && !vistos.has(a)) { vistos.add(a); lista.push(a); } };
    historico.forEach(ev => {
        (ev.amigos || []).forEach(add);
        add(ev.pagador);
        (ev.ordens || []).forEach(o => (o.amigos || []).forEach(add));
        (ev.ofertas || []).forEach(o => { add(o.quem); (o.para || []).forEach(add); });
    });
    return lista;
}
// Quem efetivamente "veio" a um evento = participou em ordens/ofertas ou pagou.
// (Não usamos ev.amigos porque essa é só a lista de candidatos pré-preenchida.)
function presentesNoEvento(ev) {
    const s = new Set();
    (ev.ordens || []).forEach(o => (o.amigos || []).forEach(a => { if (a) s.add(a); }));
    (ev.ofertas || []).forEach(o => { if (o.quem) s.add(o.quem); (o.para || []).forEach(a => { if (a) s.add(a); }); });
    if (ev.pagador) s.add(ev.pagador);
    return s;
}
// Amigos sugeridos por defeito num novo evento:
// só quem veio em >= 3 dos últimos 10 eventos, ordenados por quem mais veio.
function amigosPorDefeito() {
    const ultimos = historico.slice(-10);
    const contagem = {};
    ultimos.forEach(ev => {
        presentesNoEvento(ev).forEach(a => { contagem[a] = (contagem[a] || 0) + 1; });
    });
    return Object.keys(contagem)
        .filter(a => contagem[a] >= 3)
        .sort((a, b) => contagem[b] - contagem[a] || a.localeCompare(b, 'pt'));
}

function sbHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': `Bearer ${_sbSession?.access_token || SB_KEY}`, 'Accept-Profile': 'splitbill', 'Content-Profile': 'splitbill' };
    return Object.assign(h, extra);
}

async function sbInit() {
    // Verificar sessão em localStorage
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
        try {
            const s = JSON.parse(stored);
            _sbSession = s;
            // Token expirado ou quase? Renovar com o refresh_token antes de validar
            if (tokenQuaseExpirado()) await sbRefresh();
            let r = await fetch(`${SB_URL}/auth/v1/user`, {
                headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${_sbSession.access_token}` }
            });
            if (!r.ok && _sbSession.refresh_token) {
                // Última tentativa: refresh + revalidar (sessões antigas sem expires_at caem aqui)
                if (await sbRefresh())
                    r = await fetch(`${SB_URL}/auth/v1/user`, {
                        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${_sbSession.access_token}` }
                    });
            }
            if (r.ok) {
                const u = await r.json();
                sbSaveSession({ ..._sbSession, user: u });
                await sbAposLogin();
                return;
            }
        } catch(e) {}
        _sbSession = null;
        localStorage.removeItem(SESSION_KEY);
    }

    // Verificar OAuth callback na URL
    const hash = window.location.hash;
    if (hash.includes('access_token')) {
        const params = new URLSearchParams(hash.substring(1));
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        const expires_at = parseInt(params.get('expires_at')) || Math.floor(Date.now() / 1000) + (parseInt(params.get('expires_in')) || 3600);
        if (access_token) {
            const r = await fetch(`${SB_URL}/auth/v1/user`, {
                headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${access_token}` }
            });
            if (r.ok) {
                const u = await r.json();
                sbSaveSession({ access_token, refresh_token, expires_at, user: u });
                window.history.replaceState({}, document.title, window.location.pathname);
                await sbAposLogin();
                return;
            }
        }
    }

    // Sem sessão — mostrar login
    sbMostrarLogin();
}

function sbMostrarLogin() {
    document.getElementById('page-login').style.display = 'flex';
    if (window.sbEsconderSplash) window.sbEsconderSplash();
    document.getElementById('page-sem-acesso').style.display = 'none';
    document.getElementById('page-admin').style.display = 'none';
}

async function sbAposLogin() {
    document.getElementById('page-login').style.display = 'none';
    const email = _sbSession.user.email;

    // Verificar se tem acesso
    let data, rawText = '', statusInfo = '';
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`, {
            headers: sbHeaders({ 'Accept': 'application/json' })
        });
        statusInfo = `HTTP ${r.status}`;
        rawText = await r.text();
        try { data = JSON.parse(rawText); } catch(e) { data = null; }
    } catch(e) {
        statusInfo = 'fetch falhou: ' + e.message;
    }

    if (!Array.isArray(data) || data.length === 0) {
        // Sem acesso
        document.getElementById('page-sem-acesso').style.display = 'flex';
        document.getElementById('sem-acesso-email').textContent = `Sessão iniciada como ${email}. Esta conta não tem acesso à app.`;
        // DIAGNÓSTICO (colapsado)
        const diag = document.getElementById('sem-acesso-email');
        diag.innerHTML += `<br><br><details style="text-align:left;font-size:11px;color:#999;"><summary style="cursor:pointer;text-align:center;color:#aaa;">Detalhes técnicos</summary><span style="font-family:monospace;display:block;margin-top:6px;word-break:break-all;">${statusInfo}<br>resposta: ${(rawText || '(vazio)').substring(0, 300).replace(/</g,'&lt;')}</span></details>`;
        return;
    }

    // Tem acesso — mostrar app
    document.getElementById('page-sem-acesso').style.display = 'none';
    if (email === ADMIN_EMAIL) { sbVerificarPedidos(); }

    await sbCarregarConfigAcesso();
    await sbCarregarDados();
    init();
    verComoRestaurar();
    pushSugerirAtivacao();
}

/* O detalhe da fatura vive numa coluna `fatura jsonb` da tabela `eventos`
   (migração db/fatura-detalhe.sql). Coluna e não tabela nova: assim herda as
   políticas RLS de `eventos` — quem pode editar o evento pode gravar a fatura —
   e não é preciso sincronizar linhas nem podar nada.
   Enquanto a migração não for corrida, FATURA_COL fica false e a app funciona
   na mesma: a fatura guarda-se só no localStorage deste dispositivo. Testa-se
   uma vez por sessão, na carga dos eventos. */
let FATURA_COL = true;

/* Os convocados e o menu do evento vivem em colunas `amigos jsonb` / `menu jsonb`
   da mesma tabela (migração db/convocados-menu.sql). Antes disto NÃO existiam
   na BD: a lista era deduzida de quem aparecia nas ordens, logo um evento ainda
   sem nada lançado voltava vazio do servidor e os amigos pré-preenchidos na
   criação desapareciam ao recarregar a app. Mesmo padrão do FATURA_COL: se a
   migração não estiver corrida, a app funciona na mesma (guarda só neste
   dispositivo). Testa-se uma vez por carga dos eventos. */
let AMIGOS_COL = true;
let MENU_COL = true;

/* Autoria das ordens (`ordens.criado_por`, migração db/ordens-proprias.sql) —
   é o que permite a um convocado (não admin/substituto) adicionar/editar/apagar
   as SUAS próprias ordens num evento em aberto: sem a coluna e as políticas RLS
   que a migração cria, o servidor recusa a escrita e a app esconde os controlos
   para não prometer uma ação que ia falhar. */
let ORDENS_CRIADO_POR_COL = true;

/* Pedidos de pagamento por confirmar (`pagamentos.declarado_por`, migração
   db/pagamentos-pendentes.sql) — permite a um utilizador declarar que já pagou
   uma dívida (pendente ou prescrita); fica tipo='pendente' até o admin
   confirmar ou rejeitar. Mesmo padrão de degradação sem a migração. */
let PAGAMENTOS_PENDENTE_COL = true;

/* Notificações push (tabela `push_subscriptions`, migração
   db/push-subscriptions.sql) — sem ela o botão "Ativar notificações" nas
   Definições esconde-se. Mesmo padrão de degradação sem a migração. */
let PUSH_COL = true;

// Lista de convocados de um evento vindo da BD = a coluna `amigos` (fonte de
// verdade, editada nas Definições do evento) MAIS quem apareça nas ordens, nas
// ofertas ou seja tesoureiro. A união cobre os eventos anteriores à migração
// (coluna a null → sobra o que se deduz) e quem entre numa ordem sem estar na
// lista. Ordem preservada: primeiro os convocados, depois os deduzidos.
function convocadosDoEvento(guardados, evOrdens, evOfertas, pagador) {
    const vistos = new Set(); const lista = [];
    const add = a => { if (a && !vistos.has(a)) { vistos.add(a); lista.push(a); } };
    (guardados || []).forEach(add);
    (evOrdens || []).forEach(o => (o.amigos || []).forEach(add));
    (evOfertas || []).forEach(o => { add(o.quem); (o.para || []).forEach(add); });
    add(pagador);
    return lista;
}

async function sbCarregarDados() {
    try {
        // Carregar eventos. `fatura` vem no select=* se a coluna existir; se a
        // migração não estiver corrida, as linhas simplesmente não a trazem.
        const evRes = await sbFetch(`${SB_URL}/rest/v1/eventos?select=*&order=id.asc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const eventos = await evRes.json();
        if (Array.isArray(eventos) && eventos.length > 0) {
            const tem = c => Object.prototype.hasOwnProperty.call(eventos[0], c);
            FATURA_COL = tem('fatura');
            AMIGOS_COL = tem('amigos');
            MENU_COL = tem('menu');
        }
        if (!FATURA_COL) console.warn('[SplitBill] coluna eventos.fatura ausente — corre db/fatura-detalhe.sql para guardar o detalhe da fatura no servidor');
        if (!AMIGOS_COL || !MENU_COL) console.warn('[SplitBill] colunas eventos.amigos/menu ausentes — corre db/convocados-menu.sql para os convocados e o menu do evento viajarem entre dispositivos');

        // Carregar ordens + ordem_amigos
        const ordRes = await sbFetch(`${SB_URL}/rest/v1/ordens?select=*,ordem_amigos(amigo)&order=id.asc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const ordens = await ordRes.json();
        if (Array.isArray(ordens) && ordens.length > 0) {
            ORDENS_CRIADO_POR_COL = Object.prototype.hasOwnProperty.call(ordens[0], 'criado_por');
        }
        if (!ORDENS_CRIADO_POR_COL) console.warn('[SplitBill] coluna ordens.criado_por ausente — corre db/ordens-proprias.sql para os convocados poderem adicionar as próprias ordens');

        // Carregar ofertas + oferta_para
        const ofRes = await sbFetch(`${SB_URL}/rest/v1/ofertas?select=*,oferta_para(amigo)&order=id.asc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const ofertas = await ofRes.json();

        // Carregar pagamentos
        const pgRes = await sbFetch(`${SB_URL}/rest/v1/pagamentos?select=*&order=id.asc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const pags = await pgRes.json();
        if (Array.isArray(pags) && pags.length > 0) {
            PAGAMENTOS_PENDENTE_COL = Object.prototype.hasOwnProperty.call(pags[0], 'declarado_por');
        }
        if (!PAGAMENTOS_PENDENTE_COL) console.warn('[SplitBill] coluna pagamentos.declarado_por ausente — corre db/pagamentos-pendentes.sql para os utilizadores poderem declarar pagamentos por confirmar');

        // Tabela push_subscriptions (não coluna): existe ou não existe.
        try {
            const pushR = await sbFetch(`${SB_URL}/rest/v1/push_subscriptions?select=endpoint&limit=1`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
            PUSH_COL = pushR.ok;
        } catch(e) { PUSH_COL = false; }
        if (!PUSH_COL) console.warn('[SplitBill] tabela push_subscriptions ausente — corre db/push-subscriptions.sql para ativar notificações push');
        pushRenderStatus();

        // Reconstruir historico no formato esperado pela app
        // Faturas já guardadas neste dispositivo: sem a migração o servidor não
        // as devolve, e o historico é reconstruído por cima — sem isto perdia-se
        // o detalhe a cada login.
        // O mesmo vale para os convocados e o menu enquanto db/convocados-menu.sql
        // não for corrida: sem as colunas, o servidor não os devolve e o histórico
        // reconstruído por cima levava-os à frente.
        const faturasLocais = {}, amigosLocais = {}, menusLocais = {};
        (historico || []).forEach(e => {
            if (!e) return;
            if (e.fatura) faturasLocais[e.id] = e.fatura;
            if (Array.isArray(e.amigos) && e.amigos.length) amigosLocais[e.id] = e.amigos;
            if (e.menu && Object.keys(e.menu).length) menusLocais[e.id] = e.menu;
        });

        historico = eventos.map(ev => {
            const evOrdens = ordens.filter(o => o.evento_id === ev.id).map(o => ({
                id: o.id,
                item: o.item,
                quantidade: o.quantidade,
                precoUnitario: parseFloat(o.preco_unitario),
                precoTotal: parseFloat(o.preco_total),
                hora: o.hora,
                amigos: (o['ordem_amigos'] || []).map(a => a.amigo),
                criadoPor: o.criado_por || null
            }));
            const evOfertas = ofertas.filter(o => o.evento_id === ev.id).map(o => ({
                id: o.id,
                quem: o.quem,
                item: o.item,
                quantidade: o.quantidade,
                precoUnitario: parseFloat(o.preco_unitario),
                precoTotal: parseFloat(o.preco_total),
                hora: o.hora,
                para: (o['oferta_para'] || []).map(a => a.amigo)
            }));
            const evDividas = {};
            // recalcular dividas a partir dos pagamentos
            return {
                id: ev.id,
                descricao: ev.descricao,
                data: ev.data,
                totalFatura: ev.total_fatura ? parseFloat(ev.total_fatura) : null,
                pagador: ev.pagador,
                ordens: evOrdens,
                ofertas: evOfertas,
                amigos: convocadosDoEvento(
                    (AMIGOS_COL && Array.isArray(ev.amigos)) ? ev.amigos : amigosLocais[ev.id],
                    evOrdens, evOfertas, ev.pagador),
                menu: (MENU_COL && ev.menu && typeof ev.menu === 'object') ? ev.menu : (menusLocais[ev.id] || {}),
                dividas: evDividas,
                fatura: (FATURA_COL && ev.fatura) ? ev.fatura : (faturasLocais[ev.id] || null),
                substituto: ev.substituto_email || null
            };
        });

        pagamentos = pags.map(p => ({
            id: p.id,
            pessoa: p.pessoa,
            valor: parseFloat(p.valor),
            tipo: p.tipo,
            eventoId: p.evento_id,
            data: p.data,
            declaradoPor: p.declarado_por || null
        }));

        // Carregar divisões fixadas
        const divRes = await sbFetch(`${SB_URL}/rest/v1/eventos_divisao?select=*&order=evento_id.asc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const divRows = await divRes.json();
        divisoes = {};
        if (Array.isArray(divRows)) {
            divRows.forEach(r => {
                if (!divisoes[r.evento_id]) divisoes[r.evento_id] = {};
                divisoes[r.evento_id][r.pessoa] = parseFloat(r.quota);
            });
        }

        // Migração lazy: eventos fechados sem divisão → calcular Hamilton e guardar
        const semDivisao = historico.filter(ev => ev.totalFatura && ev.pagador && !divisoes[ev.id]);
        for (const ev of semDivisao) {
            const contaFinal = calcularContaFinalEvento(ev);
            const d = calcularDivisaoHamilton(contaFinal, ev.pagador);
            divisoes[ev.id] = d;
            sbGuardarDivisao(ev.id, d);  // fire-and-forget por evento
        }

        salvarHistoricoLocal();
        salvarPagamentos();

        // Re-sincronizar o ESTADO DE TRABALHO com o histórico acabado de
        // reconstruir. Quem chama isto fora do arranque (pull-to-refresh, botão
        // de sincronizar) ficava com `amigos`/`menu`/`estado.ordens` do evento
        // anterior presos em memória enquanto o `historico` já era outro — e o
        // próximo salvarNoLocalStorage() carimbava esse conteúdo no evento
        // actual. Era assim que um evento acabava a herdar o conteúdo de outro.
        // No arranque (sbAposLogin) o eventoAtualId ainda é null e isto não faz
        // nada: quem carrega o evento é o init(), logo a seguir.
        if (eventoAtualId != null) {
            const atual = historico.find(e => e.id == eventoAtualId);
            if (atual) carregarEvento(atual);
            else if (historico.length > 0) carregarEvento(historico[historico.length - 1]);
            else limparEstadoEvento();
            atualizarReadOnly();
        }
    } catch(e) {
        console.error('Erro ao carregar dados do Supabase:', e);
        mostrarMensagem('Erro ao carregar dados!', false);
    }
}

// ── IDs únicos e monotónicos ────────────────────────────────────────────────
// Date.now() pode repetir-se no mesmo milissegundo (duas ordens em toques
// rápidos). Com UPSERT, dois ids iguais fundem-se numa só linha → perda
// silenciosa. nextId() garante ids estritamente crescentes dentro da sessão.
let _lastId = 0;
function nextId() {
    let id = Date.now();
    if (id <= _lastId) id = _lastId + 1;
    _lastId = id;
    return id;
}

// Lança em caso de resposta não-OK do PostgREST, para a gravação ABORTAR antes
// de apagar seja o que for (em vez de continuar e perder dados em silêncio).
// O erro leva o status e o corpo do PostgREST agarrados (err.status/code/msg),
// para se poder dizer ao utilizador O QUE falhou e não só "falhou".
async function sbOk(res, ctx) {
    if (res && res.ok) return res;
    let body = null;
    try { body = await res.json(); } catch(_) {}
    const e = new Error(`${ctx} → HTTP ${res ? res.status : '?'} ${body ? JSON.stringify(body) : ''}`);
    e.ctx = ctx;
    e.status = res ? res.status : 0;
    e.code = body && body.code || '';
    e.msg = (body && (body.message || body.hint || body.details)) || '';
    throw e;
}

// Traduz o erro do PostgREST para uma frase que diga o que fazer a seguir.
// Sem isto, "falha ao guardar" é indistinguível de sessão expirada, de falta
// de permissão (RLS) ou de coluna/tabela em falta — e o bug fica invisível.
function sbErroLegivel(e) {
    if (!e) return 'erro desconhecido';
    if (e.status === undefined) return 'sem ligação ao servidor (rede ou Supabase em baixo)';
    switch (true) {
        case e.status === 0:
            return 'sem ligação ao servidor (rede ou Supabase em baixo)';
        case e.status === 401:
            return 'sessão expirada ou inválida — termina sessão e volta a entrar';
        case e.status === 403 || e.code === '42501':
            return 'sem permissão de escrita (RLS) — a tua conta pode ler mas não gravar';
        case e.status === 404 || e.code === 'PGRST205':
            return 'tabela não encontrada no schema `splitbill`';
        case e.code === '22003':
            // Date.now() tem 13 dígitos e não cabe em int4 (max ~2,1e9).
            return 'coluna de id é `integer` e não chega para os ids da app — corre db/ids-bigint.sql';
        case e.code === 'PGRST204':
            return 'coluna em falta na tabela — falta correr uma migração em db/';
        case e.code === '23503':
            return 'o evento ainda não existe na BD (chave estrangeira) — a gravação do evento falhou antes';
        case e.status === 409:
            return 'conflito de chaves na BD';
        case e.status >= 500:
            return 'erro do servidor Supabase (' + e.status + ')';
        default:
            return 'HTTP ' + e.status + (e.msg ? ' — ' + e.msg : '');
    }
}

// Sincroniza uma tabela-pai (ordens/ofertas) + a tabela-filho respetiva
// (ordem_amigos/oferta_para) com o padrão UPSERT + PRUNE: insere/atualiza tudo
// PRIMEIRO e só DEPOIS remove o que sobra. Nunca apaga linhas-pai antes de a
// inserção das novas estar confirmada — elimina a perda do bug DELETE→INSERT.
async function sbSyncFilhos(tabelaPai, tabelaFilho, fkFilho, eventoId, itens) {
    const ids = itens.map(i => i.row.id);
    if (itens.length > 0) {
        // 1) UPSERT das linhas-pai (cria/atualiza pela PK id)
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/${tabelaPai}`, {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify(itens.map(i => i.row))
        }), `upsert ${tabelaPai}`);
        // 2) Repor as linhas-filho destas linhas-pai (delete dirigido a estes ids + reinsert)
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/${tabelaFilho}?${fkFilho}=in.(${ids.join(',')})`, {
            method: 'DELETE', headers: sbHeaders()
        }), `limpar ${tabelaFilho}`);
        const filhos = itens.flatMap(i => i.filhos);
        if (filhos.length > 0) {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/${tabelaFilho}`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'return=minimal' }),
                body: JSON.stringify(filhos)
            }), `inserir ${tabelaFilho}`);
        }
        // 3) PRUNE: remover linhas-pai deste evento que já não existem (só após upsert OK)
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/${tabelaPai}?evento_id=eq.${eventoId}&id=not.in.(${ids.join(',')})`, {
            method: 'DELETE', headers: sbHeaders()
        }), `prune ${tabelaPai}`);
    } else {
        // Sem itens = limpeza intencional (utilizador removeu tudo)
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/${tabelaPai}?evento_id=eq.${eventoId}`, {
            method: 'DELETE', headers: sbHeaders()
        }), `limpar ${tabelaPai}`);
    }
}

// `opts.criar` só vem a true do criarEvento(). Sem ele isto faz PATCH, que não
// cria linhas: era esta a origem dos eventos-zombie. O upsert (POST +
// merge-duplicates) RECRIA a linha pelo id, portanto qualquer gravação de um
// evento que entretanto foi apagado — o auto-save de 2s, o flush do
// pull-to-refresh, uma aba/telemóvel com histórico velho em memória —
// ressuscitava-o na BD. Apagava-se, e ao sincronizar estava lá outra vez.
async function sbGuardarEvento(ev, opts) {
    if (!_sbSession) return;
    const criar = !!(opts && opts.criar);
    try {
        // Upsert evento — admin cria/atualiza; substituto apenas atualiza (nunca cria
        // nem mexe no campo substituto_email, protegido também por RLS/trigger).
        // `fatura` só entra no corpo se a coluna existir — senão o PostgREST
        // rejeitava o pedido inteiro (PGRST204) e o evento não se gravava.
        const campos = { descricao: ev.descricao, data: ev.data, total_fatura: ev.totalFatura, pagador: ev.pagador };
        if (FATURA_COL) campos.fatura = ev.fatura ?? null;
        // Convocados e menu: idem — só entram se as colunas existirem, senão o
        // PostgREST rejeitava o pedido inteiro (PGRST204) e o evento não gravava.
        if (AMIGOS_COL) campos.amigos = ev.amigos || [];
        if (MENU_COL) campos.menu = ev.menu || {};
        // sbOk: se a linha-pai não gravar, as ordens seguintes rebentam na chave
        // estrangeira. Sem esta verificação a causa real ficava escondida e só
        // se via o erro derivado (ou nada).
        if (isAdmin() && criar) {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos`, {
                method: 'POST',
                headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
                body: JSON.stringify(Object.assign({ id: ev.id, substituto_email: ev.substituto ?? null }, campos))
            }), 'upsert eventos');
        } else {
            const r = await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos?id=eq.${ev.id}`, {
                method: 'PATCH',
                headers: sbHeaders({ 'Prefer': 'return=representation', 'Accept': 'application/json' }),
                body: JSON.stringify(campos)
            }), 'patch eventos');
            // Zero linhas = a linha já não existe (apagada aqui ou noutro
            // dispositivo). Abortar: continuar para as ordens só daria erro de
            // chave estrangeira, e recriar o evento era exactamente o bug.
            const linhas = await r.json().catch(() => null);
            if (Array.isArray(linhas) && linhas.length === 0) {
                mostrarMensagem('⚠️ Este evento já não existe no servidor (apagado noutro dispositivo?) — as alterações não foram gravadas. Refresca para actualizar a lista.', false);
                return;
            }
        }

        // Sincronizar ordens e ofertas com UPSERT+PRUNE (nunca apaga antes de inserir)
        await sbSyncFilhos('ordens', 'ordem_amigos', 'ordem_id', ev.id,
            (ev.ordens || []).map(o => ({
                row: { id: o.id, evento_id: ev.id, item: o.item, quantidade: o.quantidade, preco_unitario: o.precoUnitario, preco_total: o.precoTotal, hora: o.hora },
                filhos: (o.amigos || []).map(a => ({ ordem_id: o.id, amigo: a }))
            }))
        );
        await sbSyncFilhos('ofertas', 'oferta_para', 'oferta_id', ev.id,
            (ev.ofertas || []).map(o => ({
                row: { id: o.id, evento_id: ev.id, quem: o.quem, item: o.item, quantidade: o.quantidade, preco_unitario: o.precoUnitario, preco_total: o.precoTotal, hora: o.hora },
                filhos: (o.para || []).map(a => ({ oferta_id: o.id, amigo: a }))
            }))
        );
    } catch(e) {
        console.error('Erro ao guardar evento no Supabase:', e);
        mostrarMensagem('⚠️ Não gravado no servidor [' + (e.ctx || 'rede') + ']: ' + sbErroLegivel(e)
            + ' · Definições → Diagnóstico da BD para detalhes.', false);
        throw e;
    }
}

/* Escrita DIRIGIDA de uma única ordem (não o evento inteiro) — usada por quem
   só pode mexer na PRÓPRIA ordem (convocado sem ser admin/substituto).
   Ao contrário de sbGuardarEvento/sbSyncFilhos (que fazem PATCH ao evento
   inteiro + upsert/prune de TODAS as ordens), aqui só se toca na linha desta
   pessoa: um convocado normal não tem — nem deve ter — permissão para mexer no
   evento nem nas ordens dos outros (ver db/ordens-proprias.sql). */
async function sbCriarOrdemPropria(ordem, eventoId) {
    if (!_sbSession) { mostrarMensagem('⚠️ Sem sessão — ordem NÃO gravada na BD', false); return false; }
    try {
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/ordens`, {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify({
                id: ordem.id, evento_id: eventoId, item: ordem.item, quantidade: ordem.quantidade,
                preco_unitario: ordem.precoUnitario, preco_total: ordem.precoTotal, hora: ordem.hora,
                criado_por: ordem.criadoPor
            })
        }), 'criar ordem própria');
        const filhos = (ordem.amigos || []).map(a => ({ ordem_id: ordem.id, amigo: a }));
        if (filhos.length > 0) {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/ordem_amigos`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'return=minimal' }),
                body: JSON.stringify(filhos)
            }), 'gravar amigos da ordem própria');
        }
        return true;
    } catch(e) {
        console.error('Erro ao criar ordem própria no Supabase:', e);
        mostrarMensagem('⚠️ Ordem NÃO gravada no servidor: ' + sbErroLegivel(e), false);
        return false;
    }
}

async function sbAtualizarOrdemPropria(ordem) {
    if (!_sbSession) { mostrarMensagem('⚠️ Sem sessão — ordem NÃO gravada na BD', false); return false; }
    try {
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/ordens?id=eq.${ordem.id}`, {
            method: 'PATCH',
            headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ item: ordem.item, quantidade: ordem.quantidade, preco_unitario: ordem.precoUnitario, preco_total: ordem.precoTotal })
        }), 'atualizar ordem própria');
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/ordem_amigos?ordem_id=eq.${ordem.id}`, {
            method: 'DELETE', headers: sbHeaders()
        }), 'limpar amigos da ordem própria');
        const filhos = (ordem.amigos || []).map(a => ({ ordem_id: ordem.id, amigo: a }));
        if (filhos.length > 0) {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/ordem_amigos`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'return=minimal' }),
                body: JSON.stringify(filhos)
            }), 'gravar amigos da ordem própria');
        }
        return true;
    } catch(e) {
        console.error('Erro ao atualizar ordem própria no Supabase:', e);
        mostrarMensagem('⚠️ Ordem NÃO atualizada no servidor: ' + sbErroLegivel(e), false);
        return false;
    }
}

async function sbApagarOrdemPropria(id) {
    if (!_sbSession) return false;
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/ordens?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders() });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.message || msg; } catch(_) {}
            mostrarMensagem('⚠️ Ordem NÃO removida da BD: ' + msg, false);
            return false;
        }
        return true;
    } catch(e) {
        console.error('Erro ao apagar ordem própria no Supabase:', e);
        mostrarMensagem('⚠️ Ordem NÃO removida da BD (erro de ligação)', false);
        return false;
    }
}

// PATCH dirigido (não upsert) para confirmar um pedido pendente. sbGuardarPagamento
// usa POST + merge-duplicates (INSERT ... ON CONFLICT DO UPDATE), que o Postgres só
// deixa passar com política de INSERT E de UPDATE — o admin tem as duas (política
// antiga, permissiva), mas o pagador (db/pagamentos-pendentes.sql) só ganhou a de
// UPDATE. Um PATCH simples só pede a de UPDATE, por isso funciona para os três.
async function sbConfirmarPedidoPagamento(id) {
    if (!_sbSession) { mostrarMensagem('⚠️ Sem sessão — pagamento NÃO confirmado na BD', false); return false; }
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/pagamentos?id=eq.${id}`, {
            method: 'PATCH',
            headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ tipo: 'evento', declarado_por: null })
        });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.message || msg; } catch(_) {}
            mostrarMensagem('⚠️ Pagamento NÃO confirmado na BD: ' + msg, false);
            return false;
        }
        return true;
    } catch(e) {
        console.error('Erro ao confirmar pedido de pagamento no Supabase:', e);
        mostrarMensagem('⚠️ Pagamento NÃO confirmado na BD (erro de ligação)', false);
        return false;
    }
}

async function sbGuardarPagamento(p) {
    if (!_sbSession) { mostrarMensagem('⚠️ Sem sessão — pagamento NÃO gravado na BD', false); return false; }
    try {
        const campos = { id: p.id, evento_id: p.eventoId, pessoa: p.pessoa, valor: p.valor, tipo: p.tipo, data: p.data };
        // declarado_por só entra se a coluna existir — senão o PostgREST rejeita
        // o pedido inteiro (PGRST204) e o pagamento nem sequer se grava.
        if (PAGAMENTOS_PENDENTE_COL) campos.declarado_por = p.declaradoPor ?? null;
        const r = await sbFetch(`${SB_URL}/rest/v1/pagamentos`, {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
            body: JSON.stringify(campos)
        });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = (j.message || msg) + (j.details ? ' · ' + j.details : '') + (j.hint ? ' · ' + j.hint : ''); } catch(_) {}
            console.error('Erro ao guardar pagamento no Supabase:', msg);
            mostrarMensagem('⚠️ Pagamento NÃO gravado na BD: ' + msg, false);
            return false;
        }
        return true;
    } catch(e) {
        console.error('Erro ao guardar pagamento no Supabase:', e);
        mostrarMensagem('⚠️ Pagamento NÃO gravado na BD (erro de ligação)', false);
        return false;
    }
}

async function sbApagarPagamento(id) {
    if (!_sbSession) return false;
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/pagamentos?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders() });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.message || msg; } catch(_) {}
            mostrarMensagem('⚠️ Pagamento NÃO removido da BD: ' + msg, false);
            return false;
        }
        return true;
    } catch(e) {
        console.error('Erro ao apagar pagamento no Supabase:', e);
        mostrarMensagem('⚠️ Pagamento NÃO removido da BD (erro de ligação)', false);
        return false;
    }
}

async function sbGuardarDivisao(eventoId, divisaoObj) {
    if (!_sbSession) return false;
    try {
        // Limpar registos anteriores deste evento
        await sbFetch(`${SB_URL}/rest/v1/eventos_divisao?evento_id=eq.${eventoId}`, { method: 'DELETE', headers: sbHeaders() });
        const rows = Object.entries(divisaoObj).map(([pessoa, quota]) => ({ evento_id: eventoId, pessoa, quota }));
        if (!rows.length) return true;
        const r = await sbFetch(`${SB_URL}/rest/v1/eventos_divisao`, {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify(rows)
        });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); msg = j.message || msg; } catch(_) {}
            console.error('Erro ao guardar divisão Supabase:', msg);
            return false;
        }
        return true;
    } catch(e) { console.error('Erro ao guardar divisão:', e); return false; }
}

async function sbApagarDivisao(eventoId) {
    if (!_sbSession) return;
    try {
        await sbFetch(`${SB_URL}/rest/v1/eventos_divisao?evento_id=eq.${eventoId}`, { method: 'DELETE', headers: sbHeaders() });
    } catch(e) { console.error('Erro ao apagar divisão:', e); }
}

// Apaga o evento no servidor e CONFIRMA que a linha desapareceu mesmo.
// Devolve true só nesse caso — quem chama não deve mexer no histórico local
// sem isso, senão o evento some do ecrã e ressuscita no arranque seguinte
// (o histórico é reconstruído a partir do servidor a cada carga).
// Duas armadilhas, e a versão anterior caía nas duas:
//   · o pedido ia fire-and-forget, sem sequer olhar ao `res.ok` — um 403 (RLS)
//     ou um 409 (chave estrangeira) passava completamente despercebido;
//   · com RLS activo, um DELETE que não encontre linhas PERMITIDAS devolve
//     204, igualzinho a um apagar bem sucedido. Sem `return=representation`
//     não há maneira de distinguir "apagado" de "a política não deixou".
async function sbApagarEvento(id) {
    if (!_sbSession) { mostrarMensagem('⚠️ Sem sessão — evento NÃO apagado', false); return false; }
    // Em modo "ver como" o sbFetch já corta a escrita e avisa. Sair aqui evita
    // um segundo aviso por cima, e sobretudo evita que ele diga "sem permissão
    // (RLS)" — que é outra coisa e mandava o diagnóstico para o sítio errado.
    if (typeof verComoAtivo === 'function' && verComoAtivo()) return false;
    const apagarLinha = () => sbFetch(`${SB_URL}/rest/v1/eventos?id=eq.${id}`, {
        method: 'DELETE', headers: sbHeaders({ 'Prefer': 'return=representation', 'Accept': 'application/json' })
    });
    try {
        let r = await apagarLinha();
        if (!r.ok) {
            let code = '';
            try { code = ((await r.clone().json()) || {}).code || ''; } catch(_) {}
            if (r.status === 409 || code === '23503') {
                // Filhos a segurar o evento (tabelas sem ON DELETE CASCADE).
                // Só se apagam DEPOIS de o servidor dizer que o problema é a
                // chave estrangeira: se fosse falta de permissão, apagá-los à
                // cabeça levava as ordens à frente e o evento ficava na mesma.
                for (const t of ['pagamentos', 'eventos_divisao', 'ordens', 'ofertas'])
                    await sbFetch(`${SB_URL}/rest/v1/${t}?evento_id=eq.${id}`, { method: 'DELETE', headers: sbHeaders() });
                r = await apagarLinha();
            }
            if (!r.ok) await sbOk(r, 'apagar eventos');
        }
        const linhas = await r.json().catch(() => null);
        if (!Array.isArray(linhas) || linhas.length === 0) {
            mostrarMensagem('⚠️ Evento NÃO apagado: o servidor aceitou o pedido mas não removeu nada — falta política DELETE em `eventos`. Ver db/diagnostico-escrita.sql (query 2).', false);
            return false;
        }
        return true;
    } catch(e) {
        console.error('Erro ao apagar evento no Supabase:', e);
        mostrarMensagem('⚠️ Evento NÃO apagado no servidor: ' + sbErroLegivel(e), false);
        return false;
    }
}

// Define/remove o substituto de um evento (só admin). PATCH direto para não mexer nas ordens.
async function sbDefinirSubstituto(eventoId, email) {
    if (!_sbSession) return;
    try {
        await sbFetch(`${SB_URL}/rest/v1/eventos?id=eq.${eventoId}`, {
            method: 'PATCH', headers: sbHeaders(),
            body: JSON.stringify({ substituto_email: email || null })
        });
    } catch(e) { console.error('Erro ao definir substituto:', e); }
}

// Carrega lista de utilizadores autorizados (só admin) + equivalências amigo↔conta (todos).
async function sbCarregarConfigAcesso() {
    // Equivalências amigo ↔ conta (visíveis a todos para mostrar "tu")
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/amigo_users?select=amigo,email`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        if (r.ok) {
            const data = await r.json();
            amigoUsers = {};
            if (Array.isArray(data)) data.forEach(row => { if (row.amigo) amigoUsers[row.amigo] = row.email; });
        }
    } catch(e) { console.error('Erro ao carregar equivalências:', e); }
    // Utilizadores autorizados — só o admin precisa (para os dropdowns).
    // isAdminReal: num reload já dentro do "ver como" a lista continua a ser
    // carregada, senão o dropdown ficava vazio ao sair do modo.
    if (isAdminReal()) {
        try {
            const r = await sbFetch(`${SB_URL}/rest/v1/allowed_users?select=email&order=email.asc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
            if (r.ok) {
                const data = await r.json();
                _allowedUsersCache = Array.isArray(data) ? data.map(u => u.email).filter(Boolean) : [];
            }
        } catch(e) { console.error('Erro ao carregar utilizadores:', e); }
    }
}

// Grava (ou remove, se email vazio) uma equivalência amigo↔conta. Só admin.
async function sbGuardarAmigoUser(amigo, email) {
    if (!_sbSession || !isAdmin()) return;
    try {
        if (email) {
            await sbFetch(`${SB_URL}/rest/v1/amigo_users`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
                body: JSON.stringify({ amigo, email })
            });
            amigoUsers[amigo] = email;
        } else {
            await sbFetch(`${SB_URL}/rest/v1/amigo_users?amigo=eq.${encodeURIComponent(amigo)}`, { method: 'DELETE', headers: sbHeaders() });
            delete amigoUsers[amigo];
        }
    } catch(e) { console.error('Erro ao guardar equivalência:', e); }
}

// Auto-save debounced
let _sbAutoSaveTimer = null;
function sbScheduleAutoSave() {
    if (!_sbSession) return;
    if (_sbAutoSaveTimer) clearTimeout(_sbAutoSaveTimer);
    _sbAutoSaveTimer = setTimeout(() => {
        const ev = historico.find(e => e.id === eventoAtualId);
        // O erro já é mostrado dentro de sbGuardarEvento; apanhar aqui evita a
        // unhandled rejection (que em alguns browsers mata o resto do timer).
        if (ev) sbGuardarEvento(ev).catch(() => {});
    }, 2000);
}

// Auth helpers
async function sbLoginGoogle() {
    window.location.href = `${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(window.location.href.split('#')[0])}`;
}

async function sbLoginEmail() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const status = document.getElementById('login-status');
    status.style.display = 'block'; status.textContent = 'A entrar…'; status.style.color = '#666';
    try {
        const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const d = await r.json();
        if (!r.ok) { status.style.color = '#B3402F'; status.textContent = d.error_description || d.msg || 'Erro ao entrar.'; return; }
        sbSaveSession({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: d.user });
        await sbAposLogin();
    } catch(e) { status.style.color = '#B3402F'; status.textContent = 'Erro de ligação.'; }
}

async function sbRegistarEmail() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const status = document.getElementById('login-status');
    status.style.display = 'block'; status.textContent = 'A criar conta…'; status.style.color = '#666';
    try {
        const r = await fetch(`${SB_URL}/auth/v1/signup`, {
            method: 'POST', headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const d = await r.json();
        if (!r.ok) { status.style.color = '#B3402F'; status.textContent = d.error_description || d.msg || 'Erro ao criar conta.'; return; }
        status.style.color = '#0E7A4F'; status.textContent = 'Conta criada! Confirma o email e volta a entrar.';
    } catch(e) { status.style.color = '#B3402F'; status.textContent = 'Erro de ligação.'; }
}

async function sbSolicitarAcesso() {
    if (!_sbSession) return;
    const btn = document.getElementById('btn-solicitar');
    const btnV = document.getElementById('btn-verificar');
    const status = document.getElementById('solicitar-status');
    btn.disabled = true; btn.textContent = 'A enviar…';
    try {
        // INSERT simples (sem merge-duplicates: ON CONFLICT DO UPDATE seria
        // recusado pela RLS — access_requests não tem policy de UPDATE).
        // 409 = pedido já registado anteriormente → também é sucesso.
        const r = await sbFetch(`${SB_URL}/rest/v1/access_requests`, {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ email: _sbSession.user.email })
        });
        if (r.ok || r.status === 409) {
            status.style.display = 'block'; status.style.color = '#0E7A4F';
            status.textContent = r.status === 409 ? '✓ O pedido já estava registado. Aguarda aprovação.' : '✓ Pedido enviado! Aguarda aprovação.';
            btn.style.display = 'none';
            btnV.style.display = '';
            if (r.ok) sbNotificarPedidoAcesso(_sbSession.user.email);  // só em pedidos novos, não em repetidos
            return;
        }
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); msg = j.message || msg; } catch(_) {}
        if (r.status === 401) msg = 'Sessão expirada — sai e volta a entrar.';
        status.style.display = 'block'; status.style.color = '#B3402F';
        status.textContent = 'Erro ao enviar pedido: ' + msg;
        btn.disabled = false; btn.textContent = 'Solicitar acesso';
    } catch(e) {
        status.style.display = 'block'; status.style.color = '#B3402F';
        status.textContent = 'Erro de ligação — tenta novamente.';
        btn.disabled = false; btn.textContent = 'Solicitar acesso';
    }
}

async function sbVerificarAcesso() {
    const btn = document.getElementById('btn-verificar');
    const status = document.getElementById('solicitar-status');
    btn.disabled = true; btn.textContent = 'A verificar…';
    await sbAposLogin();
    // Se chegou aqui ainda está no ecrã sem-acesso — acesso ainda não aprovado
    btn.disabled = false; btn.textContent = '🔄 Verificar acesso';
    status.style.display = 'block'; status.style.color = '#666';
    status.textContent = 'Acesso ainda não aprovado. Tenta mais tarde.';
}

function sbLogout() {
    // Em "ver como" este botão é o da pessoa simulada — terminava a sessão do
    // admin a sério, que não é o que se está a testar.
    if (verComoAtivo()) {
        mostrarMensagem('👁️ Estás em modo "ver como" — sai do modo primeiro.', false);
        return;
    }
    localStorage.removeItem(SESSION_KEY);
    _sbSession = null;
    window.location.reload();
}

// Admin
async function abrirAdmin() {
    document.getElementById('page-admin').style.display = 'flex';
    // Refresca a cache de contas/equivalências a cada abertura — antes só se
    // carregava uma vez no login, e contas aprovadas entretanto (ou o próprio
    // admin noutra sessão) só apareciam depois de fechar/reabrir a app.
    await sbCarregarConfigAcesso();
    renderVerComoSelect();
    pushRenderStatus();
    const lista = document.getElementById('admin-lista');
    lista.innerHTML = '<p style="color:#999;font-size:14px;text-align:center;padding:24px 0;">A carregar…</p>';
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/access_requests?select=*&order=requested_at.desc`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const data = await r.json();
        sbAtualizarBadge(Array.isArray(data) ? data.length : 0);
        if (!data.length) { lista.innerHTML = '<p style="color:#999;font-size:14px;text-align:center;padding:24px 0;">✓ Sem pedidos pendentes</p>'; return; }
        lista.innerHTML = data.map(p => `
            <div style="background:#fff;border-radius:10px;padding:14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
                <div>
                    <div style="font-weight:600;font-size:14px;">${p.email}</div>
                    <div style="font-size:12px;color:#999;">${new Date(p.requested_at).toLocaleString('pt-PT')}</div>
                </div>
                <button onclick="sbAprovarAcesso('${p.email}')" style="background:#0E7A4F;color:#fff;border:none;border-radius:7px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;">Aprovar</button>
            </div>`).join('');
    } catch(e) { lista.innerHTML = '<p style="color:#B3402F;font-size:14px;text-align:center;padding:24px 0;">Erro ao carregar pedidos.</p>'; }
}

// Atualiza o contador (badge) de pedidos pendentes no sino
function sbAtualizarBadge(n) {
    window._pedidosPendentes = n || 0;
    const badge = document.getElementById('admin-badge');
    if (badge) { if (n > 0) { badge.textContent = n; badge.style.display = ''; } else { badge.style.display = 'none'; } }
    try { var _pi = document.getElementById('page-inicio'); if (_pi && _pi.style.display !== 'none' && typeof renderInicio === 'function') renderInicio(); } catch(e) {}
}

// Verifica pedidos pendentes em segundo plano (chamado após login do admin)
async function sbVerificarPedidos() {
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/access_requests?select=email`, { headers: sbHeaders({ 'Accept': 'application/json' }) });
        const data = await r.json();
        sbAtualizarBadge(Array.isArray(data) ? data.length : 0);
    } catch(e) {}
}

async function sbAprovarAcesso(email) {
    try {
        const rIns = await sbFetch(`${SB_URL}/rest/v1/allowed_users`, {
            method: 'POST', headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
            body: JSON.stringify({ email })
        });
        if (!rIns.ok) {
            let msg = 'HTTP ' + rIns.status;
            try { const j = await rIns.json(); msg = j.message || msg; } catch(_) {}
            mostrarMensagem('Erro ao adicionar utilizador: ' + msg, false);
            return;
        }
        const rDel = await sbFetch(`${SB_URL}/rest/v1/access_requests?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE', headers: sbHeaders() });
        if (!rDel.ok) {
            mostrarMensagem(`✓ ${email} aprovado (pedido não removido — refresca manualmente).`, true);
        } else {
            mostrarMensagem(`✓ ${email} aprovado!`, true);
        }
        abrirAdmin();
    } catch(e) { mostrarMensagem('Erro ao aprovar: ' + e.message, false); }
}

function fecharAdmin() {
    document.getElementById('page-admin').style.display = 'none';
}

/* ── DIAGNÓSTICO DA BD ────────────────────────────────────────────────────
   Quando a leitura funciona e a escrita não, o culpado está quase sempre no
   servidor (política RLS em falta para INSERT/UPDATE/DELETE, coluna que a
   migração não criou, ou chave estrangeira). O browser só via "falhou".
   Este teste percorre o MESMO caminho que a gravação real — upsert do evento,
   ordens, ordem_amigos, prune — numa linha-sentinela com id negativo (nunca
   colide com os ids reais, que são Date.now()), e diz qual o passo que parte.
   Limpa sempre o que criou, mesmo se rebentar a meio. */
// id negativo com a MESMA ordem de grandeza dos ids reais (Date.now(), 13
// dígitos). Um id pequeno como -1 cabe num `integer` e escondia um eventual
// overflow de int4; negativo garante que nunca colide com um evento a sério.
let DIAG_ID = -1;

async function _diagPasso(out, nome, fn) {
    const li = document.createElement('div');
    li.style.cssText = 'font-size:12.5px;padding:6px 0;border-bottom:1px solid #E4E8E2;line-height:1.45;';
    li.innerHTML = '<span style="color:#7C8782;">⏳ ' + nome + '…</span>';
    out.appendChild(li);
    try {
        const extra = await fn();
        li.innerHTML = '<span style="color:#0E7A4F;font-weight:600;">✓ ' + nome + '</span>'
            + (extra ? '<span style="color:#7C8782;"> — ' + extra + '</span>' : '');
        return true;
    } catch (e) {
        li.setAttribute('data-falhou', '1');
        li.innerHTML = '<span style="color:#B3402F;font-weight:700;">✗ ' + nome + '</span>'
            + '<div style="color:#B3402F;">' + sbErroLegivel(e) + '</div>'
            + '<div style="color:#7C8782;font-size:11px;word-break:break-word;">'
            + (e.status ? 'HTTP ' + e.status + ' ' : '') + (e.code || '') + ' ' + (e.msg || '') + '</div>';
        return false;
    }
}

async function sbDiagnostico() {
    const out = document.getElementById('diag-out');
    if (!out) return;
    DIAG_ID = -Date.now();
    const ok = await mostrarModal({
        icon: '🩺',
        title: 'Diagnóstico da BD',
        msg: 'Vai escrever e apagar linhas de teste (id <code>' + DIAG_ID + '</code>) em <b>eventos</b>, '
           + '<b>ordens</b>, <b>ofertas</b>, <b>eventos_divisao</b> e <b>pagamentos</b>, pelo mesmo caminho '
           + 'da gravação real, para descobrir qual a operação que falha. Não toca em nenhum evento real.',
        confirmText: 'Correr teste'
    });
    if (!ok) return;

    out.innerHTML = '';
    out.style.display = '';
    // O resultado nasce abaixo dos botões, fora do que está à vista. Sem isto o
    // teste corria sem se ver nada acontecer.
    const verResultado = el => { try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch(_) {} };
    verResultado(out);
    // Este corpo é o MESMO que sbGuardarEvento envia para um evento acabado de
    // criar — incluindo `fatura` quando a coluna existe. A data usa dia > 12 de
    // propósito: se a coluna fosse `date` em vez de texto, "28/12" rebenta com
    // DateStyle MDY e "01/01" passava, escondendo o problema.
    const linhaEvento = { id: DIAG_ID, descricao: '⚙️ diagnóstico', data: '28/12/2000',
                          total_fatura: null, pagador: '', substituto_email: null };
    if (FATURA_COL) linhaEvento.fatura = null;

    await _diagPasso(out, 'Sessão', async () => {
        if (!_sbSession || !_sbSession.access_token) throw Object.assign(new Error('sem sessão'), { status: 401 });
        await sbEnsureFresh();
        const mins = _sbSession.expires_at ? Math.round((_sbSession.expires_at - Date.now() / 1000) / 60) : null;
        return (emailAtual() || '?') + (mins !== null ? ' · token válido +' + mins + ' min' : '');
    });

    await _diagPasso(out, 'Ler eventos (SELECT)', async () => {
        const r = await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos?select=*&limit=1`,
            { headers: sbHeaders({ 'Accept': 'application/json' }) }), 'select eventos');
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) return 'tabela vazia';
        const cols = Object.keys(rows[0]);
        return cols.length + ' colunas · fatura: ' + (cols.includes('fatura') ? 'sim' : 'NÃO (falta db/fatura-detalhe.sql)')
             + ' · substituto_email: ' + (cols.includes('substituto_email') ? 'sim' : 'NÃO');
    });

    // Os tipos das colunas vêm do próprio PostgREST (spec OpenAPI da raiz do
    // /rest/v1). É leitura pura e resolve de uma vez duas dúvidas que os dados
    // sozinhos não resolvem: se `eventos.id` é bigint (Date.now() tem 13
    // dígitos e NÃO cabe num integer) e se `data` é texto ou date.
    await _diagPasso(out, 'Tipos das colunas', async () => {
        // Informativo: se o PostgREST tiver a spec desligada, não é falha de
        // escrita nenhuma — não vale a pena pintar de vermelho.
        let spec = null;
        try {
            const r = await sbFetch(`${SB_URL}/rest/v1/`,
                { headers: sbHeaders({ 'Accept': 'application/openapi+json' }) });
            if (r.ok) spec = await r.json();
        } catch(_) {}
        if (!spec) return 'spec do PostgREST indisponível (não é erro de escrita)';
        const defs = (spec && (spec.definitions || (spec.components && spec.components.schemas))) || {};
        const tipo = (tab, col) => {
            const p = defs[tab] && defs[tab].properties && defs[tab].properties[col];
            return p ? (p.format || p.type) : '?';
        };
        const idEv = tipo('eventos', 'id');
        const aviso = /^integer$|^int4$/.test(idEv)
            ? ' ⛔ integer não chega para Date.now() — precisa de bigint' : '';
        return 'eventos.id: ' + idEv + aviso
             + ' · eventos.data: ' + tipo('eventos', 'data')
             + ' · ordens.id: ' + tipo('ordens', 'id')
             + ' · ordens.evento_id: ' + tipo('ordens', 'evento_id');
    });

    let evOk = await _diagPasso(out, 'Criar evento (INSERT, id e data reais)', async () => {
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos`, {
            method: 'POST', headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify(linhaEvento)
        }), 'insert eventos');
    });

    if (evOk) {
        await _diagPasso(out, 'Alterar evento (UPDATE)', async () => {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos?id=eq.${DIAG_ID}`, {
                method: 'PATCH', headers: sbHeaders(),
                body: JSON.stringify({ descricao: '⚙️ diagnóstico (2)' })
            }), 'patch eventos');
        });
        // O upsert real cai em ON CONFLICT DO UPDATE: o Postgres exige política
        // de UPDATE além da de INSERT. É a falha clássica de "só a escrita parte".
        await _diagPasso(out, 'Regravar evento (UPSERT)', async () => {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
                body: JSON.stringify(linhaEvento)
            }), 'upsert eventos');
        });
        if (FATURA_COL) {
            await _diagPasso(out, 'Gravar fatura (coluna jsonb)', async () => {
                await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos?id=eq.${DIAG_ID}`, {
                    method: 'PATCH', headers: sbHeaders(),
                    body: JSON.stringify({ fatura: { linhas: [] } })
                }), 'patch eventos.fatura');
            });
        }
        // Daqui para baixo chama-se a FUNÇÃO REAL da gravação (sbSyncFilhos), e
        // não uma imitação: assim o teste não pode ficar verde por cobrir menos
        // do que a app faz. Cobre upsert das linhas-pai, reposição das filhas,
        // e o prune `id=not.in.(…)` — que é escrita que nenhum INSERT solto testa.
        const ordemDemo = [{
            row: { id: DIAG_ID, evento_id: DIAG_ID, item: 'diagnóstico', quantidade: 1,
                   preco_unitario: 0, preco_total: 0, hora: '01/01, 00:00' },
            filhos: [{ ordem_id: DIAG_ID, amigo: 'diagnóstico' }]
        }];
        const ofertaDemo = [{
            row: { id: DIAG_ID, evento_id: DIAG_ID, quem: 'diagnóstico', item: 'diagnóstico',
                   quantidade: 1, preco_unitario: 0, preco_total: 0, hora: '01/01, 00:00' },
            filhos: [{ oferta_id: DIAG_ID, amigo: 'diagnóstico' }]
        }];

        await _diagPasso(out, 'Gravar ordens (upsert + ordem_amigos + prune)', async () => {
            await sbSyncFilhos('ordens', 'ordem_amigos', 'ordem_id', DIAG_ID, ordemDemo);
        });
        await _diagPasso(out, 'Apagar todas as ordens do evento', async () => {
            await sbSyncFilhos('ordens', 'ordem_amigos', 'ordem_id', DIAG_ID, []);
        });
        // As ofertas correm SEMPRE a seguir às ordens em sbGuardarEvento, mesmo
        // quando o evento não tem nenhuma — e nesse caso passam pelo ramo do
        // DELETE. É escrita numa tabela à parte, com políticas próprias.
        await _diagPasso(out, 'Gravar ofertas (upsert + oferta_para + prune)', async () => {
            await sbSyncFilhos('ofertas', 'oferta_para', 'oferta_id', DIAG_ID, ofertaDemo);
        });
        await _diagPasso(out, 'Apagar todas as ofertas do evento', async () => {
            await sbSyncFilhos('ofertas', 'oferta_para', 'oferta_id', DIAG_ID, []);
        });

        await _diagPasso(out, 'Gravar divisão fixada (eventos_divisao)', async () => {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos_divisao?evento_id=eq.${DIAG_ID}`,
                { method: 'DELETE', headers: sbHeaders() }), 'delete eventos_divisao');
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos_divisao`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'return=minimal' }),
                body: JSON.stringify([{ evento_id: DIAG_ID, pessoa: 'diagnóstico', quota: 0 }])
            }), 'insert eventos_divisao');
        });
        await _diagPasso(out, 'Gravar pagamento (pagamentos)', async () => {
            await sbOk(await sbFetch(`${SB_URL}/rest/v1/pagamentos`, {
                method: 'POST', headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
                body: JSON.stringify({ id: DIAG_ID, evento_id: DIAG_ID, pessoa: 'diagnóstico',
                                       valor: 0, tipo: 'pagamento', data: '01/01/2000' })
            }), 'upsert pagamentos');
        });
    }

    // Limpeza — corre sempre, mesmo com passos falhados acima.
    await _diagPasso(out, 'Limpar linhas de teste', async () => {
        for (const url of [
            `ordem_amigos?ordem_id=eq.${DIAG_ID}`, `ordens?id=eq.${DIAG_ID}`,
            `oferta_para?oferta_id=eq.${DIAG_ID}`, `ofertas?id=eq.${DIAG_ID}`,
            `eventos_divisao?evento_id=eq.${DIAG_ID}`, `pagamentos?id=eq.${DIAG_ID}`
        ]) {
            await sbFetch(`${SB_URL}/rest/v1/${url}`, { method: 'DELETE', headers: sbHeaders() });
        }
        await sbOk(await sbFetch(`${SB_URL}/rest/v1/eventos?id=eq.${DIAG_ID}`,
            { method: 'DELETE', headers: sbHeaders() }), 'delete eventos');
    });

    const rodape = document.createElement('div');
    rodape.style.cssText = 'font-size:11.5px;color:#7C8782;padding-top:10px;line-height:1.5;';
    rodape.innerHTML = 'Passos a vermelho = é aí que a escrita parte. '
        + '<b>out of range for type integer</b> (22003): as colunas de id são <code>integer</code> e os ids '
        + 'da app têm 13 dígitos — corre <code>db/ids-bigint.sql</code>. '
        + '<b>Sem permissão (RLS)</b>: falta uma política para o comando indicado (INSERT/UPDATE/DELETE) '
        + 'na tabela indicada — o upsert precisa das de INSERT <i>e</i> de UPDATE. '
        + '<b>Coluna em falta</b>: falta correr uma migração em <code>db/</code>.';
    out.appendChild(rodape);

    // Resumo no topo: com dez passos, o que interessa é saber de relance se
    // passou tudo — sem ter de percorrer a lista à procura de vermelhos.
    const falhas = out.querySelectorAll('[data-falhou="1"]').length;
    const resumo = document.createElement('div');
    resumo.style.cssText = 'font-size:13px;font-weight:700;padding:8px 10px;margin-bottom:8px;border-radius:7px;'
        + (falhas ? 'background:#FBEAE8;color:#B3402F;' : 'background:#E7F3EC;color:#0E7A4F;');
    resumo.textContent = falhas
        ? '✗ ' + falhas + ' passo(s) a falhar — ver abaixo'
        : '✓ Escrita a funcionar em todas as tabelas';
    out.insertBefore(resumo, out.firstChild);
    verResultado(resumo);
}

// Definições (cabeçalho). Admin → painel completo (pedidos/equivalências/backup);
// utilizador normal → painel simples (só terminar sessão).
function abrirDefinicoes() {
    if (isAdmin()) { abrirAdmin(); return; }
    const emailEl = document.getElementById('def-conta-email');
    if (emailEl) { const e = emailAtual(); emailEl.textContent = e ? 'Sessão iniciada como ' + e : ''; }
    document.getElementById('page-definicoes').style.display = 'flex';
    pushRenderStatus();
}

function fecharDefinicoes() {
    document.getElementById('page-definicoes').style.display = 'none';
}

// ── Equivalências amigo ↔ conta (só admin) ──
async function abrirEquivalencias() {
    if (!isAdmin()) return;
    document.getElementById('page-equivalencias').style.display = 'flex';
    // Mesma razão que em abrirAdmin(): refrescar antes de desenhar, senão contas
    // aprovadas entretanto só apareciam no combobox depois de fechar/reabrir a app.
    await sbCarregarConfigAcesso();
    renderEquivalencias();
}
function fecharEquivalencias() {
    document.getElementById('page-equivalencias').style.display = 'none';
}
function renderEquivalencias() {
    const lista = document.getElementById('equiv-lista');
    if (!lista) return;
    const todos = amigosAgregadoGlobal();
    if (!todos.length) {
        lista.innerHTML = '<p style="color:#999;font-size:14px;text-align:center;padding:20px;">Ainda não há amigos registados.</p>';
        return;
    }
    const todosEmails = _allowedUsersCache.slice();
    Object.values(amigoUsers).forEach(e => { if (e && !todosEmails.includes(e)) todosEmails.push(e); });
    todosEmails.sort();
    const emailsJaMapeados = new Set(Object.values(amigoUsers).filter(Boolean));
    lista.innerHTML = todos.map((a, i) => {
        const sel = amigoUsers[a] || '';
        const opts = ['<option value="">— sem conta —</option>']
            .concat(todosEmails.filter(e => !emailsJaMapeados.has(e) || e === sel).map(e => `<option value="${e}" ${sel === e ? 'selected' : ''}>${e}</option>`))
            .join('');
        const aEsc = a.replace(/'/g, "\\'");
        return `<div class="equiv-item">
            <span class="equiv-nome">${a}</span>
            <select id="equiv-sel-${i}" onchange="guardarEquivalencia('${aEsc}', this.value)">${opts}</select>
        </div>`;
    }).join('');
}
async function guardarEquivalencia(amigo, email) {
    if (!isAdmin()) return;
    await sbGuardarAmigoUser(amigo, email);
    mostrarMensagem(email ? ('✓ ' + amigo + ' ↔ ' + email) : ('✓ Equivalência de ' + amigo + ' removida'), true);
}

/* ── NOTIFICAÇÕES PUSH (Web Push, sem Telegram) ──────────────────────────
   Ativado por conta+dispositivo em Definições (pushAtivar/pushDesativar,
   tabela push_subscriptions — migração db/push-subscriptions.sql). Ao
   fechar uma conta, fecharComFatura() chama sbNotificarDividas() para quem
   ficou a dever; a Edge Function push-notificar resolve amigo→email e manda
   o push a cada dispositivo subscrito dessa pessoa. Sem a migração
   (PUSH_COL=false) os controlos escondem-se e a chamada não sai. */

function pushSuportado() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function pushSubscricaoAtual() {
    if (!pushSuportado()) return null;
    try {
        const reg = await navigator.serviceWorker.ready;
        return await reg.pushManager.getSubscription();
    } catch(e) { return null; }
}

// Atualiza os controlos nos painéis de Definições (admin + utilizador normal
// têm cada um a sua caixa .push-toggle-box, por isso itera todas).
async function pushRenderStatus() {
    const els = document.querySelectorAll('.push-toggle-box');
    if (!els.length) return;
    const suportado = pushSuportado();
    const email = emailSessao();
    const sub = suportado ? await pushSubscricaoAtual() : null;
    const ativo = !!sub;
    els.forEach(box => {
        if (!PUSH_COL || !suportado || !email) { box.style.display = 'none'; return; }
        box.style.display = '';
        const btn = box.querySelector('.push-toggle-btn');
        const msg = box.querySelector('.push-toggle-msg');
        if (btn) {
            btn.textContent = ativo ? '🔕 Desativar notificações' : '🔔 Ativar notificações';
            btn.onclick = ativo ? pushDesativar : pushAtivar;
        }
        if (msg) msg.textContent = ativo
            ? 'Notificações ativas neste dispositivo.'
            : 'Recebe um aviso quando ficares a dever algo novo.';
    });
}

async function pushAtivar() {
    if (!pushSuportado()) { mostrarMensagem('⚠️ Este browser não suporta notificações push', false); return; }
    const email = emailSessao();
    if (!email) return;
    try {
        const permissao = await Notification.requestPermission();
        if (permissao !== 'granted') { mostrarMensagem('⚠️ Permissão de notificações recusada', false); return; }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }
        const json = sub.toJSON();
        const r = await sbFetch(`${SB_URL}/rest/v1/push_subscriptions`, {
            method: 'POST',
            headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify({ endpoint: sub.endpoint, email, p256dh: json.keys.p256dh, auth_key: json.keys.auth })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        mostrarMensagem('✓ Notificações ativadas neste dispositivo', true);
    } catch(e) {
        console.error('Erro ao ativar notificações:', e);
        mostrarMensagem('⚠️ Não foi possível ativar notificações: ' + e.message, false);
    }
    pushRenderStatus();
}

/* Sugestão automática logo a seguir ao login — para ninguém ter de descobrir
   o botão nas Definições. Não é "obrigatório" no sentido técnico: nenhum
   browser deixa um site ativar notificações sem o utilizador carregar em
   algo (é proteção do próprio sistema, em iPhone e Android) — mas isto tira
   o único clique extra que faltava para chegar lá. Se a permissão já foi
   concedida antes (outro evento, ou já tinha dito que sim), subscreve logo
   sem mostrar nada. Se já foi recusada, não insiste — o browser nem deixava. */
async function pushSugerirAtivacao() {
    if (!PUSH_COL || !pushSuportado() || verComoAtivo()) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'granted') {
        const sub = await pushSubscricaoAtual();
        if (!sub) await pushAtivar();
        return;
    }
    const overlay = document.getElementById('push-prompt-overlay');
    if (overlay) overlay.classList.add('show');
}

function pushPromptAdiar() {
    const overlay = document.getElementById('push-prompt-overlay');
    if (overlay) overlay.classList.remove('show');
}

async function pushPromptAtivar() {
    const overlay = document.getElementById('push-prompt-overlay');
    if (overlay) overlay.classList.remove('show');
    await pushAtivar();
}

async function pushDesativar() {
    try {
        const sub = await pushSubscricaoAtual();
        if (sub) {
            await sbFetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE', headers: sbHeaders() });
            await sub.unsubscribe();
        }
        mostrarMensagem('Notificações desativadas neste dispositivo', true);
    } catch(e) {
        console.error('Erro ao desativar notificações:', e);
    }
    pushRenderStatus();
}

// Base comum aos 3 momentos (divida/pagamento_declarado/lembrete) — chama a
// Edge Function push-notificar, que decide o texto pelo `tipo` (nunca vem
// livre do cliente). Devolve {enviados, falhados} ou null se falhou a
// chamada em si (rede, timeout).
async function sbEnviarPush(tipo, pessoas, descricao, quem) {
    if (!PUSH_COL || !_sbSession || !pessoas || !pessoas.length) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
        const r = await sbFetch(`${SB_URL}/functions/v1/push-notificar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY },
            body: JSON.stringify({ tipo, pessoas, descricao: descricao || '', quem: quem || '' }),
            signal: ctrl.signal
        });
        return await r.json().catch(() => null);
    } catch(e) {
        console.warn('[SplitBill] notificação push não enviada:', e.message);
        return null;
    } finally { clearTimeout(timer); }
}

// 1) Fire-and-forget: chamada no fim de fechar uma conta, para quem ficou a
// dever. Nunca bloqueia nem incomoda o utilizador com erro — é só um extra.
function sbNotificarDividas(divisaoObj, descricao) {
    const pessoas = Object.entries(divisaoObj || {})
        .filter(([, valor]) => valor > 0.005)
        .map(([amigo, valor]) => ({ amigo, valor }));
    sbEnviarPush('divida', pessoas, descricao);
}

// 2) Fire-and-forget: chamada quando alguém declara "já paguei" — avisa o
// pagador/tesoureiro do evento (é a pessoa que supostamente recebeu).
function sbNotificarPagamentoDeclarado(pessoa, eventoId, valor) {
    const ev = historico.find(h => h.id === eventoId);
    if (!ev || !ev.pagador) return;
    sbEnviarPush('pagamento_declarado', [{ amigo: ev.pagador, valor }], ev.descricao, pessoa);
}

// Fire-and-forget: avisa o admin quando alguém pede acesso à app pela
// primeira vez. Corre mesmo para quem AINDA não está em allowed_users — é
// precisamente essa pessoa que dispara o aviso (a Edge Function só exige
// sessão válida para este tipo, não pertencer a allowed_users).
function sbNotificarPedidoAcesso(email) {
    if (!_sbSession) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    sbFetch(`${SB_URL}/functions/v1/push-notificar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY },
        body: JSON.stringify({ tipo: 'pedido_acesso', email }),
        signal: ctrl.signal
    })
        .catch(e => console.warn('[SplitBill] notificação de pedido de acesso não enviada:', e.message))
        .finally(() => clearTimeout(timer));
}

// 3) Pedido explícito do credor (pagador do evento, ou admin) para lembrar
// um devedor concreto — ao contrário dos outros dois, aqui espera-se pelo
// resultado para dar feedback (a pessoa pode não ter notificações ativas).
async function enviarLembretePagamento(pessoa, eventoId, valor) {
    if (!PUSH_COL) { mostrarMensagem('⚠️ Notificações push indisponíveis — falta uma migração na BD', false); return; }
    const ev = historico.find(h => h.id === eventoId);
    if (!ev) return;
    const ok = await mostrarModal({
        icon: '🔔',
        title: 'Enviar lembrete?',
        msg: 'Mandar uma notificação a <strong>' + pessoa + '</strong> a lembrar que deve €' + valor.toFixed(2) + '?',
        confirmText: 'Enviar lembrete',
        cancelText: 'Cancelar'
    });
    if (!ok) return;
    const quem = meusAmigos()[0] || ev.pagador || '';
    const res = await sbEnviarPush('lembrete', [{ amigo: pessoa, valor }], ev.descricao, quem);
    if (res && res.enviados > 0) mostrarMensagem('✓ Lembrete enviado a ' + pessoa, true);
    else if (res) mostrarMensagem('⚠️ ' + pessoa + ' ainda não ativou notificações', false);
    else mostrarMensagem('⚠️ Não foi possível enviar o lembrete', false);
}

/* ── FIM SUPABASE ───────────────────────────── */

// Compatibilidade: funções GitHub que ainda são referenciadas no HTML
function ghHasToken() { return podeRegistarPagamentos(); }
function ghScheduleAutoSave() { sbScheduleAutoSave(); }
function ghUpdateSyncBtn() {}
function ghLoadCfg() {}
function ghSaveCfg() {}
function ghPromptSync() {}
function ghPush() { mostrarMensagem('Dados guardados automaticamente no Supabase ✓', true); }
function ghReset() { sbCarregarDados().then(() => { renderHistoricoDropdown(); renderContas(); mostrarMensagem('✓ Dados sincronizados do Supabase', true); }); }

/* ── Swipe-back (PWA: deslizar da margem esquerda → direita p/ voltar) ── */
// Só em modo standalone (app instalada): no browser já existe o gesto/botão nativo.
function sbEmStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
}

// Cadeia de "voltar": fecha o overlay/painel ativo; senão volta ao ecrã inicial.
// É o mesmo destino do botão "Início" do cabeçalho.
function sbVoltar() {
    const modal = document.getElementById('modal-overlay');
    if (modal && modal.classList.contains('show')) return false; // confirmação a decorrer → não interferir
    const pdf = document.getElementById('pdfOverlay');
    if (pdf) { pdf.remove(); return true; }
    const fab = document.getElementById('fab-panel');
    if (fab && fab.style.display === 'block') { fecharFabPanel(); return true; }
    const equiv = document.getElementById('page-equivalencias');
    if (equiv && equiv.style.display === 'flex') { fecharEquivalencias(); return true; }
    const admin = document.getElementById('page-admin');
    if (admin && admin.style.display === 'flex') { fecharAdmin(); return true; }
    const defs = document.getElementById('page-definicoes');
    if (defs && defs.style.display === 'flex') { fecharDefinicoes(); return true; }
    if (typeof _paginaAtual !== 'undefined' && _paginaAtual && _paginaAtual !== 'inicio') {
        mudarPagina('inicio'); return true;
    }
    return false;
}

function sbSetupSwipeBack() {
    if (!sbEmStandalone()) return;
    const EDGE = 28;    // zona de arranque junto à margem esquerda (px)
    const THRESH = 70;  // distância horizontal mínima p/ confirmar (px)
    let active = false, x0 = 0, y0 = 0, dx = 0, dy = 0, hint = null;

    function getHint() {
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'sb-swipe-hint';
            hint.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
            document.body.appendChild(hint);
        }
        return hint;
    }
    function resetHint() {
        if (hint) { hint.style.opacity = '0'; hint.classList.remove('committed'); }
    }

    document.addEventListener('touchstart', e => {
        active = false;
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (t.clientX > EDGE) return;
        const modal = document.getElementById('modal-overlay');
        if (modal && modal.classList.contains('show')) return;
        active = true; x0 = t.clientX; y0 = t.clientY; dx = 0; dy = 0;
    }, { passive: true });

    document.addEventListener('touchmove', e => {
        if (!active) return;
        const t = e.touches[0];
        dx = t.clientX - x0; dy = t.clientY - y0;
        // movimento sobretudo vertical → é scroll, cancela o gesto
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) { resetHint(); active = false; return; }
        if (dx <= 0) { resetHint(); return; }
        const h = getHint();
        const prog = Math.min(dx / THRESH, 1);
        h.style.transform = 'translate(' + (dx * 0.6 - 23) + 'px,' + (t.clientY - 23) + 'px)';
        h.style.opacity = String(Math.min(prog + 0.2, 1));
        h.classList.toggle('committed', dx >= THRESH);
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (!active) return;
        active = false;
        const ok = dx >= THRESH && Math.abs(dy) < Math.abs(dx);
        resetHint();
        if (ok) sbVoltar();
    }, { passive: true });

    document.addEventListener('touchcancel', () => { active = false; resetHint(); }, { passive: true });
}

// Iniciar
sbSetupSwipeBack();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sbInit);
} else {
  sbInit();
}
setTimeout(function(){ if (window.sbEsconderSplash) window.sbEsconderSplash(); }, 6000);
