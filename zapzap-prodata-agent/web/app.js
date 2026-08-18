const chatWindow = document.querySelector("#chatWindow");
const chatStatus = document.querySelector("#chatStatus");
const agentButton = document.querySelector("#agentButton");
const closeChat = document.querySelector("#closeChat");
const scrollToBottomButton = document.querySelector("#scrollToBottom");
const messages = document.querySelector("#messages");
const typing = document.querySelector("#typing");
const composer = document.querySelector("#composer");
const cliente = document.querySelector("#cliente");
const rascunho = document.querySelector("#rascunho");
const aprendizado = document.querySelector("#aprendizado");
const modo = document.querySelector("#modo");
const pasteCliente = document.querySelector("#pasteCliente");
const pasteRascunho = document.querySelector("#pasteRascunho");
const copiarResposta = document.querySelector("#copiarResposta");
const limpar = document.querySelector("#limpar");
const salvarAprendizado = document.querySelector("#salvarAprendizado");
const sendMessage = document.querySelector("#sendMessage");

const state = {
  isOpen: false,
  isLoading: false,
  lastCustomerMessage: "",
  lastDraft: "",
  lastReply: "",
  messageCount: 0,
  openingQueued: false,
  typingTimer: null,
};

function setStatus(text, error = false) {
  chatStatus.textContent = text;
  chatStatus.style.color = error ? "#ffe3e3" : "";
}

function updateButtons() {
  const disabled = state.isLoading;
  sendMessage.disabled = disabled;
  pasteCliente.disabled = disabled;
  pasteRascunho.disabled = disabled;
  copiarResposta.disabled = disabled;
  limpar.disabled = disabled;
  salvarAprendizado.disabled = disabled;
  agentButton.disabled = false;
}

function toggleScrollButtonVisibility() {
  const threshold = 24;
  const hasOverflow = messages.scrollHeight - messages.clientHeight > threshold;
  const nearBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - threshold;
  scrollToBottomButton.hidden = !(hasOverflow && !nearBottom);
}

function scrollMessagesToBottom(behavior = "smooth") {
  messages.scrollTo({ top: messages.scrollHeight, behavior });
}

function scheduleScrollUpdate() {
  requestAnimationFrame(() => {
    toggleScrollButtonVisibility();
  });
}

function clearTypingTimer() {
  if (state.typingTimer) {
    window.clearTimeout(state.typingTimer);
    state.typingTimer = null;
  }
}

function createMessage(role, text, options = {}) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  if (options.variant) {
    bubble.classList.add(options.variant);
  }
  bubble.textContent = text;
  bubble.style.animationDelay = `${Math.min(state.messageCount * 70, 420)}ms`;
  state.messageCount += 1;

  row.appendChild(bubble);
  messages.appendChild(row);

  if (options.scroll !== false) {
    scrollMessagesToBottom(options.behavior || "smooth");
  }
  scheduleScrollUpdate();

  return bubble;
}

function showTyping() {
  clearTypingTimer();
  state.typingTimer = window.setTimeout(() => {
    typing.hidden = false;
    messages.appendChild(typing);
    scrollMessagesToBottom("smooth");
    scheduleScrollUpdate();
    state.typingTimer = null;
  }, 120);
}

function hideTyping() {
  clearTypingTimer();
  typing.hidden = true;
  if (typing.parentElement) {
    typing.parentElement.removeChild(typing);
  }
  scheduleScrollUpdate();
}

function startAgentLoading() {
  state.isLoading = true;
  setStatus("Gerando resposta...");
  agentButton.classList.remove("is-loading-phase-2");
  agentButton.classList.add("is-loading-phase-1");
  updateButtons();
}

function stopAgentLoading(message = "Pronto para responder", error = false) {
  state.isLoading = false;
  clearTypingTimer();
  agentButton.classList.remove("is-loading-phase-1", "is-loading-phase-2");
  setStatus(message, error);
  updateButtons();
}

function openChat() {
  if (state.isOpen) {
    return;
  }
  state.isOpen = true;
  chatWindow.classList.add("is-open", "is-opening");
  chatWindow.setAttribute("aria-hidden", "false");
  agentButton.setAttribute("aria-label", "Fechar agente");
  agentButton.setAttribute("aria-expanded", "true");
  window.setTimeout(() => {
    chatWindow.classList.remove("is-opening");
  }, 260);
  window.setTimeout(() => {
    cliente.focus();
  }, 50);
}

function closeChatWindow() {
  if (!state.isOpen) {
    return;
  }
  state.isOpen = false;
  chatWindow.classList.remove("is-open", "is-opening");
  chatWindow.setAttribute("aria-hidden", "true");
  agentButton.setAttribute("aria-label", "Abrir agente");
  agentButton.setAttribute("aria-expanded", "false");
  agentButton.focus({ preventScroll: true });
}

async function readClipboard(target) {
  try {
    const text = await navigator.clipboard.readText();
    target.value = text;
    target.focus();
    setStatus("Clipboard colado.");
  } catch {
    setStatus("Nao consegui ler o clipboard. Cole com Ctrl+V.", true);
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    setStatus("Resposta copiada.");
  } catch {
    setStatus("Nao consegui copiar. Selecione e copie manualmente.", true);
  }
}

async function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function addSystemMessage(text, variant = "system") {
  createMessage("assistant", text, { variant });
}

function ensureOpenAndSeed() {
  if (messages.children.length > 0) {
    return;
  }
  addSystemMessage("Envie a mensagem do cliente e eu preparo uma resposta no estilo WhatsApp.");
}

async function submitMessage(event) {
  event.preventDefault();

  const customerText = cliente.value.trim();
  const draftText = rascunho.value.trim();
  const visibleText = customerText || draftText;

  if (!visibleText) {
    setStatus("Digite a mensagem do cliente ou um rascunho.", true);
    cliente.focus();
    return;
  }

  createMessage("user", visibleText);
  state.lastCustomerMessage = customerText || visibleText;

  state.lastDraft = draftText;

  cliente.value = "";
  setStatus("Gerando resposta...");
  showTyping();
  startAgentLoading();

  const startedAt = performance.now();
  const payload = {
    cliente: customerText,
    rascunho: draftText,
    modo: modo.value,
  };

  try {
    const response = await fetch("/api/melhorar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao gerar resposta.");
    }

    const elapsed = performance.now() - startedAt;
    if (elapsed < 220) {
      await wait(220 - elapsed);
    }

    agentButton.classList.remove("is-loading-phase-1");
    agentButton.classList.add("is-loading-phase-2");

    hideTyping();
    state.lastReply = data.resposta || "";
    createMessage("assistant", state.lastReply || "Nao consegui gerar uma resposta.", {
      variant: state.lastReply ? "" : "error",
    });
    stopAgentLoading("Revise antes de enviar.");
    scrollMessagesToBottom("smooth");
  } catch (error) {
    hideTyping();
    createMessage("assistant", error.message, { variant: "error" });
    stopAgentLoading("Erro ao gerar resposta.", true);
  }
}

async function saveLearningNow() {
  const resposta = state.lastReply || "";
  const clienteText = state.lastCustomerMessage || cliente.value.trim();
  const draftText = state.lastDraft || rascunho.value.trim();
  const learningText = aprendizado.value.trim();

  if (!resposta && !learningText) {
    setStatus("Gere uma resposta ou escreva uma regra nova antes de salvar.", true);
    return;
  }

  setStatus("Salvando aprendizado...");

  try {
    const response = await fetch("/api/aprender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cliente: clienteText,
        rascunho: draftText,
        resposta,
        aprendizado: learningText,
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
}

function clearConversation() {
  messages.replaceChildren();
  typing.hidden = true;
  state.lastCustomerMessage = "";
  state.lastDraft = "";
  state.lastReply = "";
  cliente.value = "";
  rascunho.value = "";
  aprendizado.value = "";
  state.messageCount = 0;
  ensureOpenAndSeed();
  scrollMessagesToBottom("auto");
  setStatus("Pronto para responder");
}

agentButton.addEventListener("click", () => {
  if (state.isOpen) {
    closeChatWindow();
    return;
  }
  openChat();
});

closeChat.addEventListener("click", closeChatWindow);
scrollToBottomButton.addEventListener("click", () => scrollMessagesToBottom("smooth"));
composer.addEventListener("submit", submitMessage);
pasteCliente.addEventListener("click", () => readClipboard(cliente));
pasteRascunho.addEventListener("click", () => readClipboard(rascunho));
copiarResposta.addEventListener("click", () => writeClipboard(state.lastReply || ""));
limpar.addEventListener("click", clearConversation);
salvarAprendizado.addEventListener("click", saveLearningNow);
messages.addEventListener("scroll", toggleScrollButtonVisibility);

[cliente, rascunho].forEach((field) => {
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (!state.isLoading) {
      composer.requestSubmit();
    }
  });
});

window.addEventListener("resize", scheduleScrollUpdate);
window.addEventListener("load", () => {
  ensureOpenAndSeed();
  scrollMessagesToBottom("auto");
  updateButtons();
  scheduleScrollUpdate();
  agentButton.setAttribute("aria-expanded", "false");
});

setStatus("Pronto para responder");
