/**
 * @name ApagarLocal
 * @description Botão direito numa mensagem (com Shift) → "Apagar para mim" ou "Editar para mim". Silenciar pessoas. Trava com PIN. Sem histórico de busca. Só muda na sua tela. Desfazer só pela engrenagem do plugin.
 * @version 2.3.0
 */
const hex = u => [...new Uint8Array(u)].map(b => b.toString(16).padStart(2, "0")).join("");
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));

module.exports = class ApagarLocal {
    constructor(meta) {
        this.api = new BdApi(meta.name);
    }

    start() {
        // Em claro só o que o plugin precisa antes do PIN: ids e o texto já limpo.
        // Nomes, textos originais e motivos ficam no "cofre", cifrado com o PIN (abreCofre).
        this.hidden = this.api.Data.load("hidden") ?? {}; // {msgId: canal}
        this.edited = this.api.Data.load("edited") ?? {}; // {msgId: {ch, novo}}
        this.muted = this.api.Data.load("muted") ?? {}; // {userId: 1}
        this.Dispatcher = this.api.Webpack.getModule(this.api.Webpack.Filters.byKeys("dispatch", "subscribe", "register"), {searchExports: true});
        this.ack = this.api.Webpack.getModule(m => typeof m === "function" && /type:"CHANNEL_ACK"/.test(m.toString()), {searchExports: true});

        // Toda ação do Discord (mensagem nova, abrir canal, busca, menções, digitando, chamada) passa aqui antes de virar tela.
        // Silenciadas: a ação some antes de chegar nas stores, então não há tela, notificação, som, nem "não lida".
        // Editadas: troca o texto, então a edição sobrevive a reload e a edições de verdade do autor.
        const mut = m => m?.author && this.muted[m.author.id];
        const fix = m => {
            if (!m) return;
            if (this.edited[m.id]) m.content = this.edited[m.id].novo;
            if (mut(m.referenced_message)) m.referenced_message = null; // resposta a uma silenciada não mostra a citação
        };
        this.api.Patcher.instead(this.Dispatcher, "dispatch", (that, [action], orig) => {
            const t = action?.type;
            // histórico do Ctrl+F: nada novo é gravado (a loja só carrega quando a busca abre, então patcha na primeira ação de busca)
            if (t?.startsWith?.("SEARCH")) this.patchHistorico();
            if (t === "SEARCH_HISTORY_WEB_ADD_ITEM" && !this.limpando) return Promise.resolve();
            if ((t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE") && mut(action.message)) return Promise.resolve();
            if (t === "TYPING_START" && this.muted[action.userId]) return Promise.resolve();
            if (t === "CALL_CREATE" && this.mutedDMs().includes(action.channelId)) return Promise.resolve();
            // qualquer caminho até a DM (link, Ctrl+K, lista, busca) passa por CHANNEL_SELECT: barra e volta pra home
            if (t === "CHANNEL_SELECT" && this.mutedDMs().includes(action.channelId)) {
                setTimeout(() => this.go?.("/channels/@me"), 0);
                return Promise.resolve();
            }
            // histórico, busca (grupos = arrays), menções, fixadas: tira as mensagens delas
            // fora = some do resultado. No chat as apagadas somem por CSS; na busca não há esse id, então saem daqui.
            const limpa = (o, fora) => {
                if (!Array.isArray(o?.messages)) return;
                o.messages = o.messages.filter(x => Array.isArray(x) ? !x.some(y => (y.hit ?? true) && fora(y)) : !fora(x));
                o.messages.forEach(x => Array.isArray(x) ? x.forEach(fix) : fix(x));
            };
            limpa(action, mut);
            fix(action?.message);
            if (t === "CHANNEL_CREATE" || t === "CONNECTION_OPEN") setTimeout(() => this.render(), 1000);
            return orig.call(that, action);
        });

        // Busca (Ctrl+F): a loja de resultados não usa a ação filtrada acima, então filtra na leitura.
        // Mesma lista de entrada (mesmo conteúdo) → mesma lista de saída, pra não re-renderizar à toa.
        const SMS = this.api.Webpack.Stores.SearchMessageStore, cache = new WeakMap();
        const fora = m => mut(m) || this.hidden[m?.id];
        const tirados = {}; // id da busca → quantos resultados a página perdeu
        if (SMS) this.api.Patcher.after(SMS, "getMessages", (_, [id], res) => {
            if (!Array.isArray(res)) return res;
            const ids = res.flat().map(m => m?.id).join();
            let c = cache.get(res);
            if (!c || c.ids !== ids) {
                c = {ids, out: res.filter(g => ![g].flat().some(m => (m?.hit ?? true) && fora(m)))};
                c.out.flat().forEach(m => { if (m && this.edited[m.id]) try { m.content = this.edited[m.id].novo; } catch {} });
                cache.set(res, c);
            }
            tirados[id] = res.length - c.out.length;
            return c.out;
        });
        // "N resultados": desconta o que saiu. ponytail: só sabe da página aberta; páginas seguintes ainda contam no total
        if (SMS) this.api.Patcher.after(SMS, "getTotalCount", (that, [id], res) => {
            if (typeof res !== "number") return res;
            SMS.getMessages(id);
            return Math.max(0, res - (tirados[id] ?? 0));
        });

        // Sugestões de pessoas na busca ("de:", "menciona:", autores recentes): tira as silenciadas.
        // ponytail: filtro genérico por id de usuário em qualquer lista até 4 níveis; se o Discord mudar o formato, continua valendo
        const ehDela = x => x && typeof x === "object" && !Array.isArray(x) && this.muted[x.user?.id ?? x.userId ?? x.record?.id ?? x.id];
        // Só copia arrays e objetos simples quando algo muda; registros do Discord (User etc.) passam intactos.
        const tira = (v, d = 0) => {
            if (d > 4 || !v || typeof v !== "object") return v;
            let mudou = false;
            if (Array.isArray(v)) {
                const out = [];
                for (const x of v) {
                    if (typeof x === "string" ? this.muted[x] : ehDela(x)) { mudou = true; continue; }
                    const y = tira(x, d + 1);
                    if (y !== x) mudou = true;
                    out.push(y);
                }
                return mudou ? out : v;
            }
            if (Object.getPrototypeOf(v) !== Object.prototype) return v;
            const out = {};
            for (const [k, x] of Object.entries(v)) {
                out[k] = tira(x, d + 1);
                if (out[k] !== x) mudou = true;
            }
            return mudou ? out : v;
        };
        const memo = new WeakMap();
        const SAS = this.api.Webpack.Stores.SearchAutocompleteStore, SRM = this.api.Webpack.Stores.SearchRecentMessageStore;
        if (SAS) this.api.Patcher.after(SAS, "getState", (_, __, res) => {
            if (!res?.autocompletes?.length) return res;
            if (!memo.has(res)) { const a = tira(res.autocompletes); memo.set(res, a === res.autocompletes ? res : {...res, autocompletes: a}); }
            return memo.get(res);
        });
        if (SRM) this.api.Patcher.after(SRM, "getRecentMessageAuthorIds", (_, __, res) => {
            if (!Array.isArray(res) || !res.some(u => this.muted[u])) return res;
            if (!memo.has(res)) memo.set(res, res.filter(u => !this.muted[u]));
            return memo.get(res);
        });

        // Abrir/criar DM com silenciada (perfil, "Enviar mensagem", lista de amigos) e mandar mensagem pelo popout: não faz nada
        const W = this.api.Webpack;
        this.go = W.getModule(m => typeof m === "function" && m.toString().includes("transitionTo - Transitioning to"), {searchExports: true});
        const PC = W.getModule(m => m?.getOrEnsurePrivateChannel && m?.closePrivateChannel);
        const MA = W.getModule(W.Filters.byKeys("fetchMessages", "sendMessage"));
        const tem = ids => [ids].flat().some(u => this.muted[u]);
        const barra = (mod, fn, bloqueia, vazio) => mod?.[fn] && this.api.Patcher.instead(mod, fn, (that, args, orig) => bloqueia(...args) ? vazio() : orig.apply(that, args));
        barra(PC, "openPrivateChannel", e => tem(e?.recipientIds ?? e), () => Promise.resolve());
        barra(PC, "ensurePrivateChannel", e => tem(e), () => Promise.reject(new Error("silenciada")));
        barra(PC, "_openCachedDMChannel", u => tem(u), () => null);
        barra(MA, "sendMessage", ch => this.mutedDMs().includes(ch), () => Promise.resolve());

        // Notificação do sistema: nunca mostra quem mandou nem o texto (o macOS tiraria nome e foto do messageRecord)
        const N = W.getModule(m => m?.showNotification && m?.playNotificationSound);
        if (N) this.api.Patcher.instead(N, "showNotification", (that, [icone, titulo, corpo, info, op], orig) =>
            orig.call(that, null, "Twilio", "Nova mensagem", info, {...op, messageRecord: null, isUserAvatar: false, emoji: null}));

        this.patchHistorico();
        this.iniciaPin();
        this.render();
        // Itens só aparecem com Shift segurado no clique direito
        this.onCtx = e => { this.shift = e.shiftKey; };
        document.addEventListener("contextmenu", this.onCtx, true);
        this.unpatch = this.api.ContextMenu.patch("message", (tree, {message}) => {
            if (!message || !this.shift) return;
            // O Discord às vezes embrulha a lista de itens num elemento a mais
            let kids = tree.props.children;
            if (!Array.isArray(kids)) kids = kids?.props?.children;
            if (!Array.isArray(kids)) return;
            kids.push(
                this.api.ContextMenu.buildItem({type: "separator"}),
                this.api.ContextMenu.buildItem({label: "Editar para mim", action: () => this.askEdit(message)}),
                this.api.ContextMenu.buildItem({label: "Apagar para mim", danger: true, action: () => this.hide(message)})
            );
        });
    }

    stop() {
        this.unpatch?.();
        document.removeEventListener("contextmenu", this.onCtx, true);
        this.api.Patcher.unpatchAll();
        this.api.DOM.removeStyle();
        clearInterval(this.timer);
        for (const [ev, fn] of this.ouvintes ?? []) window.removeEventListener(ev, fn, true);
        this.pinEl?.remove();
    }

    // Ctrl+F: apaga o histórico salvo uma vez e esconde qualquer histórico daqui pra frente
    patchHistorico() {
        const SH = this.api.Webpack.Stores.SearchHistoryStore_Web;
        if (!SH || this.histOk) return;
        this.histOk = true;
        const St = this.api.Webpack.Stores;
        const ids = [...Object.keys(St.ChannelStore.getMutablePrivateChannels()), ...Object.keys(St.GuildStore.getGuilds())];
        let algum;
        for (const id of ids) { const h = SH.getHistory(id); if (h?.length) { h.length = 0; algum = id; } }
        // força o Discord a regravar o histórico (agora vazio); o item " " é descartado por ele mesmo ao carregar
        if (algum) { this.limpando = true; try { this.Dispatcher.dispatch({type: "SEARCH_HISTORY_WEB_ADD_ITEM", id: algum, query: " "}); } catch {} this.limpando = false; }
        const vazio = Object.freeze([]); // ponytail: "undefined" o BD ignora (mantém o original); lista vazia fixa não re-renderiza
        this.api.Patcher.after(SH, "getHistory", () => vazio);
    }

    // ---- Trava com PIN: ao abrir o Twilio, depois de 5 min parado, ou Cmd/Ctrl+Shift+L ----
    // ponytail: protege de quem senta no PC; quem apagar o plugin ou abrir o Discord no navegador passa por ela
    iniciaPin() {
        const MIN = 5;
        this.pin = this.api.Data.load("pin"); // {salt, hash} (PBKDF2)
        this.ultimo = Date.now();
        const atividade = () => { this.ultimo = Date.now(); };
        const teclas = e => { // travado: nenhuma tecla chega no Discord (Ctrl+K, atalhos...), só no campo do PIN
            if (!this.travado || e.target === this.pinInput) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            this.pinInput?.focus();
        };
        const atalho = e => {
            if (!this.travado && e.shiftKey && (e.metaKey || e.ctrlKey) && e.code === "KeyL") { e.preventDefault(); this.trava(); }
        };
        this.ouvintes = [
            ...["mousemove", "mousedown", "keydown", "wheel"].map(ev => [ev, atividade]),
            ...["keydown", "keyup", "keypress", "paste"].map(ev => [ev, teclas]),
            ["keydown", atalho]
        ];
        for (const [ev, fn] of this.ouvintes) window.addEventListener(ev, fn, true);
        this.timer = setInterval(() => { if (!this.travado && Date.now() - this.ultimo > MIN * 60000) this.trava(); }, 15000);
        this.trava();
    }

    trava() {
        if (this.travado) return;
        this.travado = true;
        this.chave = this.segredos = null; // travado, nem a memória tem os textos
        const criar = !this.pin;
        const logo = `<svg viewBox="100 100 824 824" aria-hidden="true"><defs><linearGradient id="al-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B5BF7"/><stop offset="1" stop-color="#9B4DE0"/></linearGradient></defs><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#al-g)"/><rect x="292" y="300" width="440" height="110" rx="40" fill="#fff"/><rect x="457" y="300" width="110" height="430" rx="40" fill="#fff"/></svg>`;
        const el = document.createElement("div");
        el.className = "al-trava";
        el.innerHTML = `<style>
            .al-trava{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px 16px;color:#f2f3f5;font-family:var(--font-primary,"gg sans","Noto Sans",sans-serif);
              background:radial-gradient(1200px 600px at 10% 110%,rgba(155,77,224,.55),transparent 60%),radial-gradient(900px 500px at 95% -10%,rgba(88,101,242,.65),transparent 60%),linear-gradient(160deg,#404eed 0%,#2c2f8f 45%,#1e1f22 100%)}
            .al-trava .al-forma{position:absolute;border-radius:24px;background:linear-gradient(135deg,rgba(255,255,255,.10),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);transform:rotate(-14deg)}
            .al-trava .al-estrela{position:absolute;width:3px;height:3px;border-radius:50%;background:#fff;opacity:.45}
            .al-trava .al-marca{position:absolute;top:28px;left:32px;display:flex;align-items:center;gap:10px;font-family:var(--font-display,var(--font-primary));font-weight:800;font-size:22px;letter-spacing:.01em}
            .al-trava .al-marca svg{width:30px;height:30px}
            .al-trava .al-card{position:relative;width:100%;max-width:784px;background:#313338;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.2),0 24px 64px rgba(0,0,0,.35);display:grid;grid-template-columns:1fr 240px;gap:64px;padding:32px;animation:al-entra .3s cubic-bezier(.2,.8,.2,1) both}
            @keyframes al-entra{from{opacity:0;transform:translateY(12px) scale(.98)}}
            .al-trava .al-form{text-align:center;display:flex;flex-direction:column}
            .al-trava .al-avatar{width:80px;height:80px;border-radius:50%;margin:0 auto 12px;object-fit:cover;background:#5865f2;box-shadow:0 0 0 6px #2b2d31}
            .al-trava h1{margin:0 0 8px;font-size:24px;line-height:30px;font-weight:600}
            .al-trava .al-sub{margin:0 0 20px;color:#b5bac1;font-size:16px;line-height:20px}
            .al-trava label{display:block;text-align:left;margin-bottom:8px;color:#b5bac1;font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase}
            .al-trava label .al-ast{color:#f23f42;padding-left:4px}
            .al-trava label.al-erro{color:#fa777c}
            .al-trava label .al-msg{font-style:italic;font-weight:500;text-transform:none;letter-spacing:0}
            .al-trava input{width:100%;box-sizing:border-box;height:44px;padding:10px;border:0;border-radius:3px;background:#1e1f22;color:#dbdee1;font-size:20px;letter-spacing:8px;text-align:center;outline:none;font-family:inherit}
            .al-trava input:focus{box-shadow:0 0 0 2px #00a8fc}
            .al-trava input:disabled{opacity:.5}
            .al-trava button{margin-top:20px;height:44px;border:0;border-radius:3px;background:#5865f2;color:#fff;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .17s}
            .al-trava button:hover{background:#4752c4}
            .al-trava button:disabled{opacity:.5;cursor:not-allowed}
            .al-trava .al-dica{margin-top:10px;color:#949ba4;font-size:12px;text-align:left}
            .al-trava .al-dica kbd{font-family:inherit;background:#1e1f22;border-radius:3px;padding:1px 5px;color:#b5bac1}
            .al-trava .al-lado{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
            .al-trava .al-lado .al-icone{width:176px;height:176px;margin-bottom:28px;filter:drop-shadow(0 12px 32px rgba(91,91,247,.45))}
            .al-trava .al-lado .al-icone svg{width:100%;height:100%;display:block}
            .al-trava .al-lado h2{margin:0 0 8px;font-size:24px;line-height:30px;font-weight:600}
            .al-trava .al-lado p{margin:0;color:#b5bac1;font-size:16px;line-height:20px}
            .al-trava .al-treme{animation:al-treme .35s}
            @keyframes al-treme{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
            @media (max-width:720px){.al-trava .al-card{grid-template-columns:1fr}.al-trava .al-lado{display:none}}
          </style>
          <div class="al-forma" style="width:220px;height:140px;left:6%;top:16%"></div>
          <div class="al-forma" style="width:160px;height:110px;right:8%;bottom:14%"></div>
          <div class="al-forma" style="width:90px;height:60px;right:22%;top:9%"></div>
          ${[[14,30],[28,8],[44,18],[62,6],[78,26],[88,44],[8,64],[20,86],[52,92],[70,80],[92,70],[36,52]].map(([x, y]) => `<i class="al-estrela" style="left:${x}%;top:${y}%"></i>`).join("")}
          <div class="al-marca">${logo}<span>Twilio</span></div>
          <div class="al-card">
            <form class="al-form" autocomplete="off">
              <img class="al-avatar" alt="">
              <h1></h1>
              <p class="al-sub"></p>
              <label><span class="al-rotulo">PIN</span><span class="al-ast">*</span><span class="al-msg"></span></label>
              <input type="password" inputmode="numeric" maxlength="12" autocomplete="off">
              <button type="submit"></button>
              <div class="al-dica">Trava sozinho após 5 min parado · <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>L</kbd> trava na hora</div>
            </form>
            <div class="al-lado">
              <div class="al-icone">${logo}</div>
              <h2>Twilio</h2>
              <p>Versão de comunidade do Discord. Só abre com o seu PIN.</p>
            </div>
          </div>`;
        const $ = q => el.querySelector(q);
        const form = $("form"), i = $("input"), h1 = $("h1"), sub = $(".al-sub"), botao = $("button"), label = $("label"), msg = $(".al-msg"), card = $(".al-card");
        const eu = this.api.Webpack.Stores.UserStore?.getCurrentUser?.();
        try { $(".al-avatar").src = eu?.getAvatarURL?.(null, 160) ?? ""; } catch {}
        const erro = texto => {
            label.classList.toggle("al-erro", !!texto);
            msg.textContent = texto ? ` - ${texto}` : "";
            if (texto) { card.classList.remove("al-treme"); void card.offsetWidth; card.classList.add("al-treme"); }
        };
        let primeiro = null;
        const tela = passo => {
            const textos = {
                criar: ["Proteja o seu Twilio", "Crie um PIN de 4 a 12 números. Ele vai ser pedido sempre que o app abrir.", "Continuar"],
                repetir: ["Confirme o PIN", "Digite o mesmo PIN mais uma vez.", "Criar PIN"],
                entrar: ["Boas-vindas de volta!", "Estamos muito animados em te ver novamente! Digite o seu PIN para continuar.", "Entrar"]
            }[passo];
            [h1.textContent, sub.textContent, botao.textContent] = textos;
        };
        tela(criar ? "criar" : "entrar");
        const enviar = async () => {
            const v = i.value;
            i.value = "";
            if (!/^\d{4,12}$/.test(v)) return erro("Use de 4 a 12 números");
            if (criar && !primeiro) { primeiro = v; erro(""); return tela("repetir"); }
            if (criar) {
                if (v !== primeiro) { primeiro = null; tela("criar"); return erro("Não bateu, comece de novo"); }
                const salt = crypto.getRandomValues(new Uint8Array(16));
                const pin = {salt: hex(salt), hash: await this.hashPin(v, salt)};
                await this.abreCofre(v);
                this.pin = pin;
                this.api.Data.save("pin", pin);
                return this.destrava();
            }
            botao.disabled = true;
            const ok = await this.confere(v);
            if (ok) await this.abreCofre(v);
            botao.disabled = false;
            if (ok) return this.destrava();
            this.erros = (this.erros ?? 0) + 1;
            erro("PIN errado");
            if (this.erros >= 5) {
                i.disabled = botao.disabled = true;
                erro("Muitas tentativas, espere 30 segundos");
                setTimeout(() => { i.disabled = botao.disabled = false; this.erros = 0; erro(""); i.focus(); }, 30000);
            }
        };
        form.addEventListener("submit", e => { e.preventDefault(); enviar(); });
        i.addEventListener("keydown", e => e.stopPropagation());
        i.addEventListener("blur", () => setTimeout(() => this.travado && !i.disabled && document.activeElement !== botao && i.focus(), 0));
        document.body.append(el);
        this.pinEl = el;
        this.pinInput = i;
        setTimeout(() => i.focus(), 50);
    }

    destrava() {
        this.travado = false;
        this.pinEl?.remove();
        this.pinEl = this.pinInput = null;
        this.ultimo = Date.now();
        this.erros = 0;
    }

    async hashPin(pin, salt) {
        const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
        return hex(await crypto.subtle.deriveBits({name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256"}, k, 256));
    }

    async confere(pin) {
        return !!this.pin && await this.hashPin(pin, unhex(this.pin.salt)) === this.pin.hash;
    }

    // ---- Cofre: AES-GCM com chave tirada do PIN (PBKDF2, sal próprio). A chave só existe enquanto destravado. ----
    async abreCofre(pin) {
        const c = this.api.Data.load("cofre"), novo = this.pendentes; // pendentes = vindo de "Trocar PIN"
        const salt = c && !novo ? unhex(c.salt) : crypto.getRandomValues(new Uint8Array(16));
        const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
        const chave = await crypto.subtle.deriveKey({name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256"}, k, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
        let s = novo ?? {hidden: {}, edited: {}, muted: {}};
        if (c && !novo) {
            try { s = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: unhex(c.iv)}, chave, unhex(c.ct)))); }
            catch { this.api.Data.save("cofreAntigo", c); } // PIN novo sem passar por "Trocar PIN": guarda o velho em vez de apagar
        }
        // Migração: o que ainda está em claro (nomes, textos) vai pro cofre e sai do arquivo
        let mudou = !c || !!novo;
        const separa = (nome, fica, curto) => {
            for (const [id, v] of Object.entries(this[nome])) {
                if (!v || typeof v !== "object") continue;
                const seg = {}, pub = {};
                for (const [k, x] of Object.entries(v)) (fica.includes(k) ? pub : seg)[k] = x;
                if (!Object.keys(seg).length) continue;
                s[nome][id] = {...s[nome][id], ...seg};
                this[nome][id] = curto(pub);
                mudou = true;
            }
        };
        separa("hidden", ["ch"], p => p.ch);
        separa("edited", ["ch", "novo"], p => p);
        separa("muted", [], () => 1);
        this.pendentes = null;
        this.chave = chave;
        this.salCofre = hex(salt);
        this.segredos = s;
        if (mudou) { await this.guardaCofre(); this.save(); } // cofre primeiro, depois tira do arquivo
    }

    // Em fila: a última gravação é sempre a do estado mais novo
    guardaCofre() {
        const chave = this.chave, s = this.segredos, sal = this.salCofre;
        if (!chave) return Promise.resolve();
        return this.fila = (this.fila ?? Promise.resolve()).then(async () => {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv}, chave, new TextEncoder().encode(JSON.stringify(s)));
            this.api.Data.save("cofre", {salt: sal, iv: hex(iv), ct: hex(ct)});
        }).catch(e => console.error("[ApagarLocal] cofre", e));
    }

    hide(m) {
        this.hidden[m.id] = m.channel_id;
        if (this.segredos) this.segredos.hidden[m.id] = {quem: m.author?.username ?? "?", texto: (m.content ?? "").slice(0, 80)};
        this.save();
    }

    askEdit(m) {
        const atual = this.edited[m.id]?.novo ?? m.content;
        let valor = atual;
        const R = this.api.React;
        this.api.UI.showConfirmationModal("Editar para mim", R.createElement("textarea", {
            defaultValue: atual,
            autoFocus: true,
            rows: 5,
            onChange: e => { valor = e.target.value; },
            style: {width: "100%", boxSizing: "border-box", padding: 8, borderRadius: 6, font: "inherit", resize: "vertical"}
        }), {
            confirmText: "Salvar",
            cancelText: "Cancelar",
            onConfirm: () => this.edit(m, valor)
        });
    }

    edit(m, novo) {
        if (this.segredos) this.segredos.edited[m.id] = {quem: m.author?.username ?? "?", original: this.segredos.edited[m.id]?.original ?? m.content};
        this.edited[m.id] = {ch: m.channel_id, novo};
        this.save();
        this.push(m.id, m.channel_id, novo);
    }

    // Atualiza a mensagem já na tela (o patch do dispatch aplica o texto salvo)
    push(id, ch, content) {
        this.Dispatcher.dispatch({type: "MESSAGE_UPDATE", message: {id, channel_id: ch, content}});
    }

    save() {
        this.api.Data.save("hidden", this.hidden);
        this.api.Data.save("edited", this.edited);
        this.api.Data.save("muted", this.muted);
        this.guardaCofre();
        this.render();
    }

    // DMs 1:1 com quem está silenciada
    mutedDMs() {
        return Object.values(this.api.Webpack.Stores.ChannelStore.getMutablePrivateChannels())
            .filter(c => c.type === 1 && c.recipients.some(u => this.muted[u])).map(c => c.id);
    }

    // ponytail: esconde por CSS pelo id do <li> (chat-messages-<canal>-<msg>) e pelo link da DM; se o Discord mudar isso, é só ajustar aqui
    render() {
        const dms = this.mutedDMs();
        const sel = [
            ...Object.entries(this.hidden).map(([msg, v]) => `[id="chat-messages-${v.ch ?? v}-${msg}"]`),
            ...dms.map(ch => `li:has(a[href="/channels/@me/${ch}"])`)
        ].join(",\n");
        this.api.DOM.removeStyle();
        if (sel) this.api.DOM.addStyle(`${sel} { display: none !important; }`);
        // o que chegou com o Discord fechado: marca a DM como lida
        const RS = this.api.Webpack.Stores.ReadStateStore;
        for (const ch of dms) if (RS?.hasUnread?.(ch)) try { this.ack?.(ch, undefined, true, true); } catch {}
    }

    restoreEdit(id) {
        const e = this.edited[id], original = this.segredos?.edited[id]?.original;
        delete this.edited[id];
        delete this.segredos?.edited[id];
        this.save();
        if (e && original != null) this.push(id, e.ch, original);
    }

    getSettingsPanel() {
        const root = document.createElement("div");
        root.style.cssText = "color:var(--text-normal);display:flex;flex-direction:column;gap:8px";
        const btn = (txt, fn) => {
            const b = document.createElement("button");
            b.textContent = txt;
            b.style.cssText = "padding:4px 10px;border-radius:4px;border:0;background:#5865f2;color:#fff;cursor:pointer;flex:none";
            b.onclick = () => { fn(); draw(); };
            return b;
        };
        const row = (txt, b) => {
            const r = document.createElement("div");
            r.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:space-between";
            const s = document.createElement("span");
            s.textContent = txt;
            s.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            r.append(s, b);
            return r;
        };
        const title = t => {
            const h = document.createElement("h3");
            h.textContent = t;
            h.style.cssText = "font-weight:600;margin-top:8px";
            return h;
        };
        const portao = () => { // painel só abre com o PIN, toda vez
            root.replaceChildren(title("Digite o PIN para ver o painel"));
            const f = document.createElement("form"), i = document.createElement("input"), aviso = document.createElement("span");
            i.type = "password"; i.inputMode = "numeric"; i.maxLength = 12; i.autocomplete = "off";
            i.style.cssText = "height:36px;padding:0 10px;border:0;border-radius:3px;background:#1e1f22;color:#dbdee1;font-size:18px;letter-spacing:6px;width:180px";
            aviso.style.color = "#fa777c";
            f.style.cssText = "display:flex;gap:8px;align-items:center";
            const ok = document.createElement("button");
            ok.textContent = "Abrir"; ok.type = "submit";
            ok.style.cssText = "padding:8px 14px;border-radius:4px;border:0;background:#5865f2;color:#fff;cursor:pointer";
            f.append(i, ok, aviso);
            f.onsubmit = async e => {
                e.preventDefault();
                const v = i.value; i.value = ""; ok.disabled = true;
                const certo = await this.confere(v);
                ok.disabled = false;
                if (!certo) return void (aviso.textContent = "PIN errado");
                if (!this.segredos) return void (aviso.textContent = "Destrave o Twilio primeiro");
                draw();
            };
            root.append(f);
            setTimeout(() => i.focus(), 50);
        };
        const draw = () => {
            const S = this.segredos;
            root.replaceChildren();
            root.append(title("Trava com PIN"));
            root.append(row("Trava ao abrir, após 5 min parado ou com Cmd/Ctrl+Shift+L", btn("Bloquear agora", () => this.trava())));
            // ponytail: o PIN velho continua no arquivo até o novo ser criado; fechar no meio não perde o cofre
            root.append(row("Quer trocar? Cria um PIN novo agora.", btn("Trocar PIN", () => { this.pendentes = this.segredos; this.pin = null; this.trava(); })));
            root.append(title(`Apagadas (${Object.keys(this.hidden).length})`));
            for (const [id, v] of Object.entries(this.hidden)) {
                const x = S.hidden[id];
                root.append(row(x?.quem ? `${x.quem}: ${x.texto}` : id, btn("Restaurar", () => { delete this.hidden[id]; delete S.hidden[id]; this.save(); })));
            }
            root.append(title(`Editadas (${Object.keys(this.edited).length})`));
            for (const [id, v] of Object.entries(this.edited)) {
                const x = S.edited[id];
                root.append(row(`${x?.quem ?? "?"}: "${(x?.original ?? "?").slice(0, 40)}" → "${v.novo.slice(0, 40)}"`, btn("Restaurar", () => this.restoreEdit(id))));
            }
            root.append(title(`Silenciadas (${Object.keys(this.muted).length})`));
            for (const [id, v] of Object.entries(this.muted)) {
                const x = S.muted[id];
                root.append(row(x?.quem ? `${x.quem}${x.pron ? ` (${x.pron})` : ""}` : id, btn("Reativar", () => { delete this.muted[id]; delete S.muted[id]; this.save(); })));
            }
            if (Object.keys(this.hidden).length + Object.keys(this.edited).length) {
                root.append(btn("Restaurar tudo", () => {
                    for (const id of Object.keys(this.edited)) this.restoreEdit(id);
                    this.hidden = {};
                    S.hidden = {};
                    this.save();
                }));
            }
        };
        portao();
        return root;
    }
};
