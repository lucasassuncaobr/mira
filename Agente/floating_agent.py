#!/usr/bin/env python3
import threading
import re
import concurrent.futures

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

from cdp_client import CdpClient, CdpError, EXTRACT_CONTEXT_JS
from server import DEFAULT_MODEL, MODEL_FILE, build_context, known_prodata_reply, ollama_generate, read_text, save_learning


def clean_context(text):
    lines = []
    noise = {
        "tail-out",
        "tail-in",
        "wds-ic-read",
        "ic-image",
        "foto",
        "mensagem",
        "digite uma mensagem",
        "plus-rounded",
        "mic-outlined",
        "forward-refreshed",
        "encaminhada",
        "list-people",
    }
    for raw in (text or "").splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        line = re.sub(r"\s*\d{1,2}:\d{2}$", "", line).strip()
        if not line:
            continue
        low = line.lower()
        if low in noise:
            continue
        if re.fullmatch(r"\d{1,2}:\d{2}", line):
            continue
        if "criptografia de ponta a ponta" in low:
            continue
        if low.startswith(("wds-", "ic-", "default-", "lock-outline", "plus-", "mic-", "forward-")):
            continue
        if not lines or lines[-1] != line:
            lines.append(line)
    return "\n".join(lines[-12:])


def last_message_is_mine(context):
    lines = [line.strip().lower() for line in (context or "").splitlines() if line.strip()]
    return bool(lines and lines[-1].startswith("eu:"))


def bad_suggestion(text):
    value = (text or "").strip()
    if len(value) < 18:
        return True
    lowered = value.lower()
    bad_prefixes = ("luc", "lucas", "resposta:", "**resposta:**")
    if lowered in bad_prefixes or any(lowered == item for item in bad_prefixes):
        return True
    if lowered.startswith("luc\n") or lowered == "luc":
        return True
    return False


def text_from(view):
    buffer = view.get_buffer()
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True).strip()


def set_text(view, text):
    view.get_buffer().set_text(text or "")


class FloatingAgent(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Resposta Prodata")
        self.set_default_size(430, 560)
        self.set_size_request(430, 560)
        self.set_resizable(False)
        self.set_focusable(False)
        self.cdp = CdpClient()
        self.connected = False
        self.last_context = ""
        self.last_learned_pair = ""
        self.learned_pairs = set()
        self.generating = False
        self.apply_dark_style()

        header = Gtk.HeaderBar()
        header.add_css_class("agent-header")
        header.set_show_title_buttons(True)
        header_title = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        header_title.add_css_class("header-title-box")
        title = Gtk.Label(label="Prodata Assist")
        title.add_css_class("title")
        subtitle = Gtk.Label(label="ZapZap")
        subtitle.add_css_class("subtitle")
        header_title.append(title)
        header_title.append(subtitle)
        header.set_title_widget(header_title)
        self.set_titlebar(header)

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.add_css_class("agent-root")
        root.set_margin_top(12)
        root.set_margin_bottom(12)
        root.set_margin_start(12)
        root.set_margin_end(12)
        self.set_child(root)

        self.status = Gtk.Label(label="Conectando no ZapZap...")
        self.status.add_css_class("status")
        self.status.set_xalign(0)
        root.append(self.status)

        context_label = Gtk.Label(label="Contexto")
        context_label.add_css_class("section-label")
        context_label.set_xalign(0)
        root.append(context_label)
        self.context = self.text_view(92, "context-box")
        root.append(self.context["scroll"])

        response_label = Gtk.Label(label="Sugestao")
        response_label.add_css_class("section-label")
        response_label.set_xalign(0)
        root.append(response_label)
        self.response = self.text_view(210, "response-box")
        root.append(self.response["scroll"])

        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        buttons.add_css_class("button-row")
        root.append(buttons)

        refresh = Gtk.Button(label="Ler")
        refresh.add_css_class("ghost")
        refresh.connect("clicked", lambda _b: self.refresh_context(force=True))
        buttons.append(refresh)

        accept = Gtk.Button(label="Aceitar")
        accept.add_css_class("accept")
        accept.connect("clicked", lambda _b: self.accept_response())
        buttons.append(accept)

        save = Gtk.Button(label="Aprender")
        save.add_css_class("ghost")
        save.connect("clicked", lambda _b: self.learn())
        buttons.append(save)

        hint = Gtk.Label(label="Sugestao automatica. Ctrl+Enter aceita no ZapZap")
        hint.add_css_class("hint")
        hint.set_xalign(0)
        root.append(hint)

        key = Gtk.EventControllerKey()
        key.connect("key-pressed", self.on_key)
        self.add_controller(key)

        GLib.timeout_add(900, self.refresh_context)

    def text_view(self, height, css_class):
        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(height)
        scroll.add_css_class("agent-scroll")
        scroll.add_css_class(css_class)
        view = Gtk.TextView()
        view.add_css_class("agent-text")
        view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        scroll.set_child(view)
        return {"scroll": scroll, "view": view}

    def apply_dark_style(self):
        css = b"""
        window, headerbar {
          background: #050607;
          color: #f3f6f4;
        }
        headerbar.agent-header {
          background: #07110d;
          border-bottom: 1px solid #18241e;
          box-shadow: none;
        }
        .header-title-box {
          margin: 2px 0;
        }
        .title {
          color: #f3f6f4;
          font-weight: 700;
          font-size: 15px;
        }
        .subtitle {
          color: #25d366;
          font-size: 11px;
        }
        .agent-root {
          background: #050607;
          color: #f3f6f4;
        }
        label {
          color: #f3f6f4;
        }
        .status {
          color: #9eb2aa;
          font-size: 12px;
          padding: 2px 0 0 0;
        }
        .section-label {
          color: #d7e4de;
          font-weight: 700;
          font-size: 12px;
          margin-top: 2px;
        }
        .agent-scroll {
          background: #0d1512;
          border: 1px solid #1e2c26;
          border-radius: 10px;
          padding: 1px;
        }
        .context-box {
          background: #0b100e;
        }
        .response-box {
          background: #0f1915;
          border-color: #244236;
        }
        textview,
        textview text,
        .agent-text,
        .agent-text text {
          background: #0f1915;
          color: #f3f6f4;
          caret-color: #25d366;
          font-size: 14px;
        }
        button {
          min-height: 38px;
          background: #121a17;
          color: #f3f6f4;
          border: 1px solid #2c3b34;
          border-radius: 8px;
          padding: 7px 12px;
          font-weight: 700;
        }
        button:hover {
          background: #1a2520;
          border-color: #25d366;
        }
        button.primary {
          background: #128c5a;
          border-color: #25d366;
          color: #ffffff;
        }
        button.accept {
          background: #075e54;
          border-color: #128c5a;
          color: #ffffff;
        }
        button.ghost {
          background: #0b1110;
          color: #d7e4de;
        }
        .button-row button {
          margin-top: 4px;
        }
        .hint {
          color: #71817a;
          font-size: 11px;
        }
        switch {
          color: #25d366;
        }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        display = Gdk.Display.get_default()
        if display:
            Gtk.StyleContext.add_provider_for_display(
                display,
                provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
            )

    def set_status(self, text):
        self.status.set_text(text)

    def ensure_connected(self):
        if self.connected:
            return True
        try:
            self.cdp.connect_whatsapp()
            self.connected = True
            self.set_status("Conectado ao ZapZap.")
            return True
        except Exception as exc:
            self.set_status(f"Abra o ZapZap pelo lancador com agente. {exc}")
            return False

    def refresh_context(self, force=False):
        if not self.ensure_connected():
            return True
        try:
            context = clean_context(self.cdp.evaluate(EXTRACT_CONTEXT_JS, timeout=4))
        except Exception as exc:
            self.connected = False
            self.set_status(f"Reconectando... {exc}")
            return True
        if not context:
            self.last_context = ""
            set_text(self.context["view"], "")
            self.set_status("Abra uma conversa no ZapZap para eu ler o contexto.")
            return True
        if context and context != self.last_context:
            self.last_context = context
            set_text(self.context["view"], context)
            self.learn_from_conversation(context)
            self.set_status("Conversa atualizada.")
            self.generate_from_context()
        return True

    def learn_from_conversation(self, context):
        lines = [line.strip() for line in (context or "").splitlines() if line.strip()]
        if len(lines) < 2:
            return
        previous_customer = ""
        for line in lines:
            lowered = line.lower()
            if lowered.startswith("cliente:"):
                previous_customer = line.split(":", 1)[1].strip()
                continue
            if not lowered.startswith("eu:") or not previous_customer:
                continue
            answer = line.split(":", 1)[1].strip()
            question = previous_customer
            if len(answer) < 8 or len(question) < 8:
                continue
            key = f"{question} -> {answer}"
            if key in self.learned_pairs:
                continue
            self.learned_pairs.add(key)
            self.last_learned_pair = key
            save_learning(
                question,
                "",
                answer,
                "Aprendido automaticamente da conversa: resposta digitada pelo Lucas após mensagem do cliente.",
            )

    def generate_from_context(self):
        if self.generating:
            return
        context = text_from(self.context["view"])
        if not context:
            self.set_status("Nao consegui ler a conversa.")
            return
        set_text(self.response["view"], "")
        if last_message_is_mine(context):
            self.set_status("Aguardando resposta do cliente.")
            return
        known = known_prodata_reply(context, "", "profissional")
        if known:
            set_text(self.response["view"], known)
            self.set_status("Sugestao por regra local.")
            return
        set_text(self.response["view"], self.contextual_fallback(context))
        self.set_status("Sugestao rapida.")

    def generate_worker(self, context):
        model = read_text(MODEL_FILE) or DEFAULT_MODEL
        memory = build_context()
        prompt = f"""
Voce e um copiloto de atendimento Prodata.
Leia o contexto extraido da conversa aberta no ZapZap e sugira a proxima resposta do atendente.
Responda somente com a mensagem para o cliente.
Nao invente procedimentos, valores, prazos, links ou garantias.
Se faltar informacao, peca print, mensagem exata do erro, empresa/CNPJ ou etapa onde ocorreu.
Use no maximo 5 frases curtas.
Se o cliente disser "mesmo erro", "mesmo problema" ou algo vago, peca print e diga que vai comparar com o caso anterior.
Se o atendente ja disse que esta verificando, gere uma resposta curta de acompanhamento, sem repetir demais.
Se houver problema tecnico no contexto, nunca responda apenas "certo" ou "qualquer coisa"; oriente o proximo passo concreto.
Se o contexto falar em banco, cadastro, prefeitura, empenho, cota, fonte, evento ou chamado, responda como suporte tecnico do Prodata.
Nao comece com o nome do atendente. Nao use markdown. Nao use titulo.

Memoria local:
{memory}

Contexto da conversa:
{context}

Resposta sugerida:
""".strip()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(ollama_generate, prompt, model)
                result = future.result(timeout=18)
            GLib.idle_add(self.finish_generate, result, "")
        except concurrent.futures.TimeoutError:
            fallback = known_prodata_reply(context, "", "profissional") or self.contextual_fallback(context)
            GLib.idle_add(self.finish_generate, fallback, "")
        except RuntimeError as exc:
            GLib.idle_add(self.finish_generate, "", str(exc))

    def finish_generate(self, result, error):
        self.generating = False
        if error:
            self.set_status(error)
        else:
            result = (result or "").strip()
            if bad_suggestion(result):
                context = text_from(self.context["view"])
                result = known_prodata_reply(context, "", "profissional") or self.contextual_fallback(context)
            set_text(self.response["view"], result)
            self.set_status("Revise. Ctrl+Enter aceita.")
        return False

    def contextual_fallback(self, context):
        text = (context or "").lower()
        if "banco" in text and ("corrigir" in text or "alter" in text or "quebrou" in text):
            return (
                "Entendi. Como houve alteração no banco, preciso conferir o caso antes de orientar a correção. "
                "Me envie o print da tela e os dados do registro afetado para eu verificar com segurança."
            )
        if "chamado" in text:
            return (
                "Entendi. Abra o chamado com um resumo do caso e, se possível, inclua prints ou a mensagem que aparece. "
                "Com o número do chamado eu consigo acompanhar e orientar melhor."
            )
        if any(word in text for word in ["erro", "problema", "negativa", "empenho", "empenhar", "orçamento", "orcamento", "fonte", "cadastro", "evento"]):
            return (
                "Entendi. Me envie um print da tela e informe em qual etapa isso aparece para eu verificar com mais precisão."
            )
        return "Certo. Qualquer coisa, fico à disposição."

    def accept_response(self):
        text = text_from(self.response["view"])
        if not text:
            self.set_status("Gerando sugestao antes de aceitar...")
            self.generate_from_context()
            return
        if not self.ensure_connected():
            return
        try:
            ok = self.focus_message_box()
            if ok:
                self.replace_message_box_text(text)
                context = text_from(self.context["view"])
                save_learning(context, "", text, "Resposta aceita pelo agente flutuante.")
        except CdpError as exc:
            self.set_status(f"Nao consegui preencher: {exc}")
            return
        self.set_status("Resposta preenchida no ZapZap." if ok else "Campo de mensagem nao encontrado.")

    def focus_message_box(self):
        expression = r"""
(() => {
  const box = document.querySelector('[data-testid="conversation-compose-box-input"][contenteditable="true"]')
    || Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find((el) =>
      /Digite uma mensagem/i.test(el.getAttribute('aria-label') || '')
    );
  if (!box) return false;
  box.focus();
  return true;
})()
"""
        return bool(self.cdp.evaluate(expression, timeout=5))

    def replace_message_box_text(self, text):
        self.cdp.call(
            "Input.dispatchKeyEvent",
            {
                "type": "keyDown",
                "key": "Control",
                "code": "ControlLeft",
                "windowsVirtualKeyCode": 17,
                "nativeVirtualKeyCode": 17,
                "modifiers": 2,
            },
        )
        self.cdp.call(
            "Input.dispatchKeyEvent",
            {
                "type": "keyDown",
                "key": "a",
                "code": "KeyA",
                "windowsVirtualKeyCode": 65,
                "nativeVirtualKeyCode": 65,
                "modifiers": 2,
            },
        )
        self.cdp.call(
            "Input.dispatchKeyEvent",
            {
                "type": "keyUp",
                "key": "a",
                "code": "KeyA",
                "windowsVirtualKeyCode": 65,
                "nativeVirtualKeyCode": 65,
                "modifiers": 2,
            },
        )
        self.cdp.call(
            "Input.dispatchKeyEvent",
            {
                "type": "keyUp",
                "key": "Control",
                "code": "ControlLeft",
                "windowsVirtualKeyCode": 17,
                "nativeVirtualKeyCode": 17,
                "modifiers": 0,
            },
        )
        for event_type in ("keyDown", "keyUp"):
            self.cdp.call(
                "Input.dispatchKeyEvent",
                {
                    "type": event_type,
                    "key": "Backspace",
                    "code": "Backspace",
                    "windowsVirtualKeyCode": 8,
                    "nativeVirtualKeyCode": 8,
                },
            )
        self.cdp.call("Input.insertText", {"text": text})

    def learn(self):
        context = text_from(self.context["view"])
        response = text_from(self.response["view"])
        if not response:
            self.set_status("Sem resposta para aprender.")
            return
        save_learning(context, "", response, "Resposta aprovada pela janela flutuante.")
        self.set_status("Aprendizado salvo.")

    def on_key(self, _controller, keyval, _keycode, state):
        ctrl = state & 4
        if ctrl and keyval in (65293, 65421):
            self.accept_response()
            return True
        return False


class FloatingApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="local.prodata.floating.v2")

    def do_activate(self):
        FloatingAgent(self).present()


def main():
    FloatingApp().run(None)


if __name__ == "__main__":
    main()
