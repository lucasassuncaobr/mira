const cliente = document.querySelector("#cliente");
const rascunho = document.querySelector("#rascunho");
const resposta = document.querySelector("#resposta");
const aprendizado = document.querySelector("#aprendizado");
const statusEl = document.querySelector("#status");
const modo = document.querySelector("#modo");

// [IMPROVED] Mantem o ponto de acao visivel apos novas respostas.
function scrollResponseIntoView() {
  resposta.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", error);
}

async function readClipboard(target) {
  try {
    target.value = await navigator.clipboard.readText();
    target.focus();
  } catch {
    setStatus("Nao consegui ler o clipboard. Cole com Ctrl+V.", true);
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Resposta copiada.");
  } catch {
    setStatus("Nao consegui copiar. Selecione e copie manualmente.", true);
  }
}

document.querySelector("#colarCliente").addEventListener("click", () => readClipboard(cliente));
document.querySelector("#colarRascunho").addEventListener("click", () => readClipboard(rascunho));
document.querySelector("#copiar").addEventListener("click", () => writeClipboard(resposta.value));

// [IMPROVED] Enter envia para gerar resposta; Shift+Enter continua quebrando linha.
[cliente, rascunho].forEach((field) => {
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    document.querySelector("#melhorar").click();
  });
});

document.querySelector("#salvarAprendizado").addEventListener("click", async () => {
  setStatus("Salvando aprendizado...");

  try {
    const response = await fetch("/api/aprender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cliente: cliente.value,
        rascunho: rascunho.value,
        resposta: resposta.value,
        aprendizado: aprendizado.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Falha ao salvar aprendizado.");
    }
    aprendizado.value = "";
    setStatus("Aprendizado salvo localmente.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.querySelector("#limpar").addEventListener("click", () => {
  cliente.value = "";
  rascunho.value = "";
  resposta.value = "";
  aprendizado.value = "";
  setStatus("");
  cliente.focus();
});

document.querySelector("#melhorar").addEventListener("click", async () => {
  setStatus("Gerando resposta...");
  resposta.value = "";

  try {
    const response = await fetch("/api/melhorar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cliente: cliente.value,
        rascunho: rascunho.value,
        modo: modo.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Falha ao gerar resposta.");
    }
    resposta.value = data.resposta;
    setStatus("Revise antes de enviar.");
    resposta.focus();
    scrollResponseIntoView(); // [IMPROVED] Auto-scroll suave quando a IA responde.
  } catch (error) {
    setStatus(error.message, true);
  }
});
