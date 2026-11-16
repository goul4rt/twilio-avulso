// Passagem secreta: 5 cliques no ícone grande do Twilio (em até 3 s) mostram o campo de PIN.
// PIN certo libera o Discord no navegador por 30 min. Só funciona como extensão (Chrome/Arc).
(() => {
  if (!globalThis.chrome?.declarativeNetRequest) return;
  const MIN = 30;
  const icone = document.querySelector(".app");
  const form = document.getElementById("passe");
  const campo = form.querySelector("input");
  const rotulo = form.querySelector("label");
  let cliques = [], erros = 0;

  icone.addEventListener("click", () => {
    const agora = Date.now();
    cliques = [...cliques.filter(t => agora - t < 3000), agora];
    if (cliques.length >= 5) { form.hidden = false; campo.focus(); cliques = []; }
  });

  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const confere = async pin => {
    const {salt, hash} = await (await fetch("segredo.json")).json();
    const s = new Uint8Array(salt.match(/../g).map(h => parseInt(h, 16)));
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({name: "PBKDF2", salt: s, iterations: 200000, hash: "SHA-256"}, k, 256)) === hash;
  };

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const v = campo.value;
    campo.value = "";
    if (await confere(v)) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({disableRulesetIds: ["discord"]});
      await chrome.alarms.create("travar", {delayInMinutes: MIN});
      location.href = "https://discord.com/app";
      return;
    }
    rotulo.classList.add("erro");
    if (++erros >= 5) { campo.disabled = true; setTimeout(() => { campo.disabled = false; erros = 0; rotulo.classList.remove("erro"); }, 30000); }
  });
})();
