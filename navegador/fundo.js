// Liberação temporária: a página de aviso desliga o bloqueio; aqui ele volta sozinho.
const liga = () => chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds: ["discord"]});
chrome.alarms.onAlarm.addListener(a => { if (a.name === "travar") liga(); });
chrome.runtime.onStartup.addListener(liga); // fechou o navegador = trava de novo
chrome.runtime.onInstalled.addListener(liga);
