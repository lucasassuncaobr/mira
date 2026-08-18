#!/usr/bin/env python3
import base64
import concurrent.futures
import io
import json
import os
import re
import subprocess
import time
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import datetime

from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from cdp_client import CdpClient, EXTRACT_CONTEXT_JS, MESSAGE_ROWS_JS
from server import generate_prodata_preview_details, generate_prodata_response_details, is_learning_candidate, save_learning, is_valid_pair, warm_local_support_models

ZAPZAP_APP_ID = os.environ.get("ZAPZAP_APP_ID", "com.rtosta.zapzap").strip() or "com.rtosta.zapzap"
ZAPZAP_DEVTOOLS_PORT = int(os.environ.get("ZAPZAP_DEVTOOLS_PORT", "9222") or 9222)
ZAPZAP_DEVTOOLS_JSON_URL = f"http://127.0.0.1:{ZAPZAP_DEVTOOLS_PORT}/json"
ROOT = os.path.dirname(os.path.abspath(__file__))


def _read_data_uri(path: str) -> str:
    try:
        with open(path, "rb") as handle:
            payload = base64.b64encode(handle.read()).decode("ascii")
        return f"data:image/png;base64,{payload}"
    except OSError:
        return ""


ESTAGIARIO_LOGO_SRC = _read_data_uri(os.path.join(ROOT, "web", "assets", "estagiario-logo.png"))

_OCR_ACCENT_MAP = {
    "acao": "ação",
    "acoes": "ações",
    "ajuda": "ajuda",
    "algum": "algum",
    "analise": "análise",
    "area": "área",
    "areas": "áreas",
    "atencao": "atenção",
    "autorizacao": "autorização",
    "automatica": "automática",
    "automaticao": "automático",
    "boa": "boa",
    "comprovacao": "comprovação",
    "copia": "cópia",
    "dados": "dados",
    "depois": "depois",
    "descricao": "descrição",
    "detalhe": "detalhe",
    "disponivel": "disponível",
    "divisao": "divisão",
    "documentacao": "documentação",
    "equipe": "equipe",
    "especial": "especial",
    "excelente": "excelente",
    "facil": "fácil",
    "funcao": "função",
    "geracao": "geração",
    "geral": "geral",
    "informacao": "informação",
    "informacoes": "informações",
    "nao": "não",
    "necessario": "necessário",
    "numero": "número",
    "orcamento": "orçamento",
    "otimizacao": "otimização",
    "padrao": "padrão",
    "pagina": "página",
    "producao": "produção",
    "proximo": "próximo",
    "publico": "público",
    "requisicao": "requisição",
    "requisicoes": "requisições",
    "resolucao": "resolução",
    "resposta": "resposta",
    "selecao": "seleção",
    "servicos": "serviços",
    "sistema": "sistema",
    "situacao": "situação",
    "solucao": "solução",
    "tambem": "também",
    "tecnico": "técnico",
    "texto": "texto",
    "usuario": "usuário",
    "util": "útil",
    "voce": "você",
    "voces": "vocês",
}


def _is_command_like(text):
    value = (text or "").strip()
    if not value:
        return False
    if "_" in value:
        return True
    if any(char.isdigit() for char in value) and len(value) > 8:
        return True
    if value.upper() == value and len(value) > 6:
        return True
    if re.fullmatch(r"[A-Za-z0-9._/-]+", value) and len(value) > 16:
        return True
    return False


def _restore_ocr_accents(text):
    if not text or _is_command_like(text):
        return text
    parts = []
    for token in re.split(r"(\W+)", text):
        if not token or re.fullmatch(r"\W+", token):
            parts.append(token)
            continue
        if _is_command_like(token):
            parts.append(token)
            continue
        lower = token.lower()
        repl = _OCR_ACCENT_MAP.get(lower)
        if repl:
            if token.isupper():
                parts.append(repl.upper())
            elif token[:1].isupper():
                parts.append(repl[:1].upper() + repl[1:])
            else:
                parts.append(repl)
        else:
            parts.append(token)
    return "".join(parts)


def _prepare_ocr_image(image):
    image = image.convert("L")
    base = max(image.size)
    if base and base < 1600:
        scale = min(2.0, 1600 / float(base))
        if scale > 1.0:
            image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    image = ImageOps.autocontrast(image)
    image = ImageEnhance.Contrast(image).enhance(1.35)
    image = ImageEnhance.Sharpness(image).enhance(1.8)
    image = image.filter(ImageFilter.MedianFilter(size=3))
    return image


def _normalize_ocr_text(text):
    return re.sub(r"[ \t]+", " ", (text or "").replace("\r", "")).strip()


def _group_ocr_lines(items):
    groups = []
    for item in items or []:
        if not item:
            continue
        text = ""
        box = None
        if isinstance(item, (list, tuple)):
            if len(item) >= 2:
                text = str(item[1]).strip()
            if item and isinstance(item[0], (list, tuple)) and item[0]:
                box = item[0]
        if not text:
            continue
        item_data = {"text": text, "box": box}
        if box and len(box) >= 4:
            xs = [point[0] for point in box if isinstance(point, (list, tuple)) and len(point) >= 2]
            ys = [point[1] for point in box if isinstance(point, (list, tuple)) and len(point) >= 2]
            if xs and ys:
                item_data["x"] = min(xs)
                item_data["y"] = sum(ys) / len(ys)
                item_data["h"] = max(ys) - min(ys)
                item_data["w"] = max(xs) - min(xs)
        if "y" not in item_data:
            item_data["x"] = 0
            item_data["y"] = len(groups) * 16
            item_data["h"] = 16
            item_data["w"] = len(text) * 8
        placed = False
        for group in groups:
            group_y = group["y"]
            group_h = group["h"]
            tolerance = max(12, group_h * 0.75)
            if abs(item_data["y"] - group_y) <= tolerance:
                group["items"].append(item_data)
                count = len(group["items"])
                group["y"] = ((group_y * (count - 1)) + item_data["y"]) / count
                group["h"] = max(group_h, item_data["h"])
                placed = True
                break
        if not placed:
            groups.append({
                "y": item_data["y"],
                "h": item_data["h"],
                "items": [item_data],
            })
    lines = []
    for group in sorted(groups, key=lambda entry: entry["y"]):
        texts = [entry["text"] for entry in sorted(group["items"], key=lambda entry: entry.get("x", 0))]
        line = _normalize_ocr_text(" ".join(texts))
        if line:
            lines.append(line)
    return lines


def _merge_fragmented_lines(lines):
    merged = []
    buffer = ""
    for line in lines or []:
        line = _normalize_ocr_text(line)
        if not line:
            continue
        if not buffer:
            buffer = line
            continue
        short_buffer = len(buffer) <= 28
        short_line = len(line) <= 22
        broken_heading = (
            short_buffer
            and short_line
            and not re.search(r"[.!?:;,-]$", buffer)
            and not re.search(r"^\d", line)
        )
        if broken_heading:
            buffer = f"{buffer} {line}".strip()
            continue
        merged.append(buffer)
        buffer = line
    if buffer:
        merged.append(buffer)
    return merged


def _cleanup_ocr_text(text):
    raw_lines = [line.strip() for line in (text or "").replace("\r", "\n").split("\n")]
    lines = [line for line in raw_lines if line]
    lines = _merge_fragmented_lines(lines)
    cleaned = []
    for line in lines:
        line = _normalize_ocr_text(line)
        line = re.sub(r"\s+([,.;:!?])", r"\1", line)
        line = re.sub(r"(?<=\w)-\s+(?=\w)", "-", line)
        line = _restore_ocr_accents(line)
        if line:
            cleaned.append(line)
    return "\n".join(cleaned).strip()


def perform_ocr(image_path):
    temp_path = None
    try:
        with Image.open(image_path) as image:
            prepared = _prepare_ocr_image(image)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp:
                prepared.save(temp.name)
                temp_path = temp.name
        if temp_path:
            image_path = temp_path
    except Exception:
        pass

    try:
        from rapidocr_onnxruntime import RapidOCR

        if not hasattr(perform_ocr, "_rapidocr"):
            perform_ocr._rapidocr = RapidOCR()
        result = perform_ocr._rapidocr(image_path)
        if isinstance(result, tuple):
            result = result[0]
        lines = _group_ocr_lines(result)
        text = _cleanup_ocr_text("\n".join(lines))
        if text:
            return text
    except Exception:
        pass

    try:
        from pytesseract import image_to_string

        with Image.open(image_path) as image:
            prepared = _prepare_ocr_image(image)
            text = image_to_string(prepared, lang="por+eng", config="--psm 6").strip()
        text = _cleanup_ocr_text(text)
        if text:
            return text
    except Exception:
        pass

    try:
        result = subprocess.run(
            ["tesseract", image_path, "stdout", "-l", "por+eng", "--psm", "6"],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        text = _cleanup_ocr_text(result.stdout)
        if text:
            return text
    except Exception:
        pass
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    raise RuntimeError("Nenhum motor OCR disponivel. Instale rapidocr-onnxruntime ou tesseract.")


def write_clipboard_text(text):
    commands = (["wl-copy"], ["xclip", "-selection", "clipboard"])
    for attempt in range(3):
        for args in commands:
            try:
                result = subprocess.run(
                    args,
                    input=text,
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=False,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0:
                return True
        time.sleep(0.08 * (attempt + 1))
    return False


def capture_ocr_text(cdp, target):
    if not target:
        raise RuntimeError("Nao foi possivel localizar a area da imagem.")
    rect = target.get("selection") or target.get("target")
    if not rect:
        raise RuntimeError("Selecione uma area da imagem para OCR.")
    temp_path = None
    try:
        cdp.evaluate(
            """
(() => {
  const ids = ['prodata-assist-inline', 'prodata-assist-inline-opener', 'prodata-assist-inline-ocr'];
  ids.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.dataset.prodataOcrPrevVisibility = element.style.visibility || '';
    element.style.visibility = 'hidden';
  });
  return true;
})()
""",
            timeout=2,
        )
        screenshot = cdp.call("Page.captureScreenshot", {"format": "png", "fromSurface": True}, timeout=12)
        png_data = base64.b64decode(screenshot.get("data", ""))
        image = Image.open(io.BytesIO(png_data))
        dpr = float(cdp.evaluate("window.devicePixelRatio || 1", timeout=2) or 1)
        left = max(0, int(rect["x"] * dpr))
        top = max(0, int(rect["y"] * dpr))
        right = min(image.width, int((rect["x"] + rect["width"]) * dpr))
        bottom = min(image.height, int((rect["y"] + rect["height"]) * dpr))
        if right <= left or bottom <= top:
            raise RuntimeError("A area selecionada e invalida.")
        crop = image.crop((left, top, right, bottom)).convert("RGB")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp:
            crop.save(temp.name)
            temp_path = temp.name
        return perform_ocr(temp_path)
    finally:
        try:
            cdp.evaluate(
                """
(() => {
  const ids = ['prodata-assist-inline', 'prodata-assist-inline-opener', 'prodata-assist-inline-ocr'];
  ids.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.style.visibility = element.dataset.prodataOcrPrevVisibility || '';
    delete element.dataset.prodataOcrPrevVisibility;
  });
  return true;
})()
""",
                timeout=2,
            )
        except Exception:
            pass
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def capture_chat_context_image(cdp):
    rect = cdp.evaluate(
        """
(() => {
  const root = document.querySelector('#main');
  if (!root) return null;
  const box = root.getBoundingClientRect();
  return {
    x: box.left,
    y: box.top,
    width: box.width,
    height: box.height,
    dpr: window.devicePixelRatio || 1
  };
})()
""",
        timeout=3,
    )
    if not isinstance(rect, dict):
        return ""
    screenshot = cdp.call("Page.captureScreenshot", {"format": "png", "fromSurface": True}, timeout=12)
    png_data = base64.b64decode(screenshot.get("data", ""))
    image = Image.open(io.BytesIO(png_data)).convert("RGB")
    dpr = max(1.0, float(rect.get("dpr") or 1.0))
    left = max(0, int(rect["x"] * dpr))
    top = max(0, int(rect["y"] * dpr))
    right = min(image.width, int((rect["x"] + rect["width"]) * dpr))
    bottom = min(image.height, int((rect["y"] + rect["height"]) * dpr))
    if right <= left or bottom <= top:
        return ""
    crop = image.crop((left, top, right, bottom))
    if crop.height > 420:
        crop = crop.crop((0, int(crop.height * 0.12), crop.width, crop.height))
    max_edge = max(crop.width, crop.height)
    if max_edge > 1500:
        scale = 1500.0 / float(max_edge)
        crop = crop.resize(
            (max(1, int(crop.width * scale)), max(1, int(crop.height * scale))),
            Image.Resampling.LANCZOS,
        )
    output = io.BytesIO()
    crop.save(output, format="JPEG", quality=82, optimize=True)
    return base64.b64encode(output.getvalue()).decode("ascii")


PANEL_JS = r"""
(() => {
  const widgetVersion = '2026-07-12i';
  const id = 'prodata-assist-inline';
  const openerId = 'prodata-assist-inline-opener';
  const styleId = 'prodata-assist-inline-style';
  const hiddenStateKey = 'prodata-assist-inline-hidden';
  const bootVersionKey = 'prodata-assist-inline-boot-version';
  let panel = document.getElementById(id);
  let opener = document.getElementById(openerId);
  let style = document.getElementById(styleId);
  const hasRuntimeHooks = () => (
    typeof window.__prodataAssistGetOcrState === 'function'
    && typeof window.__prodataAssistSyncOcrControls === 'function'
    && typeof window.__prodataAssistApplyFloatingAnchor === 'function'
  );
  const isPanelValid = (element) => Boolean(
    element
    && element.getAttribute('data-version') === widgetVersion
    && element.querySelector('.pa-suggestion')
    && element.querySelector('.pa-source-options')
    && element.querySelector('.pa-accept')
  );
  const isOpenerValid = (element) => Boolean(
    element
    && element.getAttribute('data-version') === widgetVersion
    && element.querySelector('.pa-opener-ring-progress')
  );
  if (!isPanelValid(panel) || !hasRuntimeHooks()) {
    if (panel) panel.remove();
    panel = null;
  }
  if (!isOpenerValid(opener) || !hasRuntimeHooks()) {
    if (opener) opener.remove();
    opener = null;
  }
  if (style && style.getAttribute('data-version') !== widgetVersion) {
    style.remove();
    style = null;
  }
  if (localStorage.getItem(bootVersionKey) !== widgetVersion) {
    localStorage.setItem(bootVersionKey, widgetVersion);
    localStorage.setItem(hiddenStateKey, '1');
  } else if (localStorage.getItem(hiddenStateKey) === null) {
    localStorage.setItem(hiddenStateKey, '1');
  }
  const ensurePanelOpen = () => {
    if (!panel) return;
    panel.style.display = '';
    panel.classList.remove('pa-closing');
    panel.classList.add('pa-open');
    panel.style.setProperty('opacity', '1', 'important');
    panel.style.visibility = 'visible';
    if (opener) opener.style.display = 'none';
  };
    const minimizePanel = () => {
      if (!panel || panel.style.display === 'none') return;
      localStorage.setItem(hiddenStateKey, '1');
      panel.classList.remove('pa-open');
      panel.classList.remove('pa-closing');
    if (opener) opener.style.display = 'block';
    if (opener?.__prodataLoadingFinishTimer) window.clearTimeout(opener.__prodataLoadingFinishTimer);
    if (opener?.__prodataPulseTimer) window.clearTimeout(opener.__prodataPulseTimer);
    if (opener?.__prodataCleanupTimer) window.clearTimeout(opener.__prodataCleanupTimer);
    if (opener) {
      opener.dataset.loadingPhase = 'idle';
      opener.classList.remove('loading-active');
      opener.classList.remove('loading-complete');
      opener.classList.remove('loading-finishing');
      opener.classList.remove('pulse-complete');
      }
      resetRingVisual();
      panel.style.display = 'none';
    };
  const stopRingAnimation = () => {
    if (opener && opener.__prodataRingRaf) {
      window.cancelAnimationFrame(opener.__prodataRingRaf);
      opener.__prodataRingRaf = null;
    }
  };
  const resetRingVisual = () => {
    stopRingAnimation();
    if (!opener) return;
    const progressRing = opener.querySelector('.pa-opener-ring-progress');
    const fullRing = opener.querySelector('.pa-opener-ring-full');
    if (progressRing) {
      progressRing.style.opacity = '0';
      progressRing.style.strokeDashoffset = '0';
      progressRing.style.animation = 'none';
    }
    if (fullRing) {
      fullRing.style.opacity = '0';
    }
  };
  const startRingAnimation = () => {
    if (!opener) return;
    stopRingAnimation();
    const progressRing = opener.querySelector('.pa-opener-ring-progress');
    const fullRing = opener.querySelector('.pa-opener-ring-full');
    if (progressRing) {
      progressRing.style.opacity = '0';
      progressRing.style.animation = 'none';
      progressRing.style.strokeDashoffset = '0';
    }
    if (fullRing) {
      fullRing.style.opacity = '0';
    }
  };
  if (!panel) {
    panel = document.createElement('div');
    panel.id = id;
    panel.innerHTML = `
      <div class="pa-head">
        <div class="pa-head-brand">
          <div class="pa-logo-shell">
            <img class="pa-logo" src="__ESTAGIARIO_LOGO__" alt="">
          </div>
          <div>
            <div class="pa-title">Estagiário</div>
            <div class="pa-status">aguardando conversa</div>
          </div>
        </div>
        <div class="pa-head-actions">
          <button class="pa-close" title="Ocultar" aria-label="Ocultar painel">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6 6L18 18"></path>
              <path d="M18 6L6 18"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="pa-body">
        <div class="pa-update-template">
          <div class="pa-template-head">
            <div class="pa-label">Atualização</div>
            <button class="pa-template-generate" type="button">Gerar comunicado</button>
          </div>
          <div class="pa-template-fields">
            <label>
              <span>Data</span>
              <input class="pa-update-date" type="text" inputmode="numeric" placeholder="28/05/2026" maxlength="10">
            </label>
            <label>
              <span>Horário</span>
              <input class="pa-update-time" type="text" inputmode="numeric" placeholder="15:00" maxlength="5">
            </label>
            <label class="pa-version-field">
              <span>Versão</span>
              <input class="pa-update-version" type="text" placeholder="Sig Integrações Rest 4.0.113">
            </label>
          </div>
        </div>
        <div class="pa-source-row">
          <div class="pa-source-options"></div>
        </div>
        <div class="pa-typing" hidden>
          <span class="pa-typing-dot"></span>
          <span class="pa-typing-dot"></span>
          <span class="pa-typing-dot"></span>
        </div>
        <div class="pa-suggestion"></div>
        <div class="pa-actions">
          <button class="pa-accept">Aceitar</button>
        </div>
      </div>
    `;
    style = document.createElement('style');
    style.id = styleId;
    style.setAttribute('data-version', widgetVersion);
    style.textContent = `
      /* [IMPROVED] Fontes profissionais separando interface e mensagens. */
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Roboto:wght@400;500&display=swap'); /* [FONT] */
      #prodata-assist-inline,
      #prodata-assist-inline *,
      #prodata-assist-inline-opener {
        box-sizing: border-box;
        font-family: "Plus Jakarta Sans", system-ui, sans-serif; /* [IMPROVED] Fonte de interface. */
        letter-spacing: -0.01em; /* [IMPROVED] Coesao visual. */
        transition: none !important;
        animation: none !important;
        scroll-behavior: auto !important;
      }
      #prodata-assist-inline-opener {
        position: fixed;
        right: 18px;
        bottom: 96px; /* [IMPROVED] Evita sobrepor controles nativos do WhatsApp. */
        z-index: 999999;
        display: none;
        border: 0;
        background: transparent;
        color: #f4fff9;
        border-radius: 0;
        width: 58px;
        height: 58px;
        padding: 0;
        font: 600 12px/1 "Plus Jakarta Sans", system-ui, sans-serif;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        cursor: pointer;
        box-shadow: none;
        transition: transform .3s ease, opacity .3s ease; /* [IMPROVED] Hover suave. */
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: visible;
      }
      #prodata-assist-inline-opener::before,
      #prodata-assist-inline-opener::after {
        content: none;
      }
      #prodata-assist-inline-opener .pa-opener-ring {
        position: absolute;
        inset: -3px;
        width: calc(100% + 6px);
        height: calc(100% + 6px);
        pointer-events: none;
        transform: rotate(-90deg);
        overflow: visible;
        filter: drop-shadow(0 0 4px rgba(124, 244, 214, 0.14));
      }
      #prodata-assist-inline-opener .pa-opener-ring-track,
      #prodata-assist-inline-opener .pa-opener-ring-full,
      #prodata-assist-inline-opener .pa-opener-ring-progress {
        fill: none;
        stroke-width: 1.45;
        shape-rendering: geometricPrecision;
        vector-effect: non-scaling-stroke;
      }
      #prodata-assist-inline-opener .pa-opener-ring-track {
        stroke: rgba(160, 255, 229, 0.1);
      }
      #prodata-assist-inline-opener .pa-opener-ring-full {
        stroke: #d8fff7;
        opacity: 0;
        pointer-events: none;
        transition: opacity .24s ease;
      }
      #prodata-assist-inline-opener .pa-opener-ring-progress {
        stroke: rgba(184, 255, 240, 0.98);
        stroke-linecap: round;
        stroke-dasharray: 28 109;
        stroke-dashoffset: 0;
        opacity: 0;
        transform-origin: 19px 19px;
        transition: opacity .18s ease, stroke .18s ease, filter .18s ease;
        filter: drop-shadow(0 0 4px rgba(184, 255, 240, 0.18));
      }
      #prodata-assist-inline-opener .pa-opener-logo {
        position: relative;
        z-index: 1;
        width: 60px;
        height: 60px;
        display: block;
        margin: auto;
        object-fit: contain;
        transform: translateY(-5px) scale(1);
        filter: drop-shadow(0 1px 5px rgba(0, 0, 0, 0.22));
        transform-origin: center center;
        animation: logoContourPulse 4.8s ease-in-out infinite;
        will-change: transform, filter;
      }
      #prodata-assist-inline-opener:hover {
        opacity: 1;
        transform: scale(1.03);
      }
      #prodata-assist-inline-opener:focus-visible {
        outline: none;
        opacity: 1;
        transform: scale(1.03);
      }
      @keyframes logoContourPulse {
        0%, 100% {
          transform: translateY(-5px) scale(1);
          filter:
            drop-shadow(0 1px 5px rgba(0, 0, 0, 0.22))
            drop-shadow(0 0 6px rgba(255, 255, 255, 0.10))
            drop-shadow(0 0 10px rgba(37, 211, 102, 0.08));
        }
        50% {
          transform: translateY(-5px) scale(1.05);
          filter:
            drop-shadow(0 1px 5px rgba(0, 0, 0, 0.24))
            drop-shadow(0 0 8px rgba(255, 255, 255, 0.16))
            drop-shadow(0 0 14px rgba(37, 211, 102, 0.16));
        }
      }
      #prodata-assist-inline-opener.loading-complete .pa-opener-logo,
      #prodata-assist-inline-opener.pulse-complete .pa-opener-logo {
        animation:
          logoContourPulse 4.8s ease-in-out infinite,
          logoReadyGlow .42s ease-out 1;
      }
      @keyframes logoReadyGlow {
        0% {
          filter:
            drop-shadow(0 1px 5px rgba(0, 0, 0, 0.22))
            drop-shadow(0 0 6px rgba(255, 255, 255, 0.08));
        }
        55% {
          filter:
            drop-shadow(0 1px 5px rgba(0, 0, 0, 0.24))
            drop-shadow(0 0 12px rgba(255, 255, 255, 0.16))
            drop-shadow(0 0 18px rgba(37, 211, 102, 0.18));
        }
        100% {
          filter:
            drop-shadow(0 1px 5px rgba(0, 0, 0, 0.22))
            drop-shadow(0 0 6px rgba(255, 255, 255, 0.08));
        }
      }
      #prodata-assist-inline-ocr {
        position: fixed;
        z-index: 999999;
        display: none;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 122px;
        height: 36px;
        padding: 0 14px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 999px;
        background: linear-gradient(135deg, rgba(0, 116, 96, 0.82), rgba(22, 170, 146, 0.74));
        color: #f4fff9;
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        box-shadow: 0 12px 28px rgba(0, 0, 0, .26), inset 0 1px 0 rgba(255, 255, 255, .08);
        font: 600 12px/1 "Plus Jakarta Sans", system-ui, sans-serif;
        cursor: crosshair;
        transition: opacity .2s ease, transform .2s ease, background .2s ease, box-shadow .2s ease;
      }
      #prodata-assist-inline-ocr::after {
        content: '';
        position: absolute;
        inset: -1px;
        border-radius: inherit;
        background: radial-gradient(circle at 50% 40%, rgba(255, 255, 255, .24), rgba(255, 255, 255, .1) 30%, rgba(255, 255, 255, 0) 72%);
        opacity: 0;
        transform: scale(.92);
        pointer-events: none;
      }
      #prodata-assist-inline-ocr.is-visible {
        display: inline-flex;
      }
      #prodata-assist-inline-ocr:hover {
        transform: translateY(-1px);
        background: linear-gradient(135deg, rgba(0, 116, 96, 0.92), rgba(22, 170, 146, 0.86));
        box-shadow: 0 14px 32px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(255, 255, 255, .1);
      }
      #prodata-assist-inline-ocr.is-active {
        color: rgba(255, 255, 255, 0.98);
        border-color: rgba(255, 255, 255, 0.62);
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.18) inset,
          0 0 8px rgba(255, 255, 255, 0.16),
          0 12px 28px rgba(0, 0, 0, .26);
      }
      #prodata-assist-inline-ocr.is-flashing {
        color: rgba(255, 255, 255, 0.98);
        border-color: rgba(255, 255, 255, 0.72);
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.2) inset,
          0 0 10px rgba(255, 255, 255, 0.2),
          0 12px 28px rgba(0, 0, 0, .26);
      }
      #prodata-assist-inline-ocr.is-flashing::after,
      #prodata-assist-inline-ocr.is-active::after {
        opacity: 1;
        transform: scale(1);
      }
      #prodata-assist-inline-ocr svg {
        display: block;
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }
      #prodata-assist-inline-ocr-overlay {
        position: fixed;
        inset: 0;
        z-index: 999998;
        display: none;
        cursor: crosshair;
        background: transparent;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      #prodata-assist-inline-ocr-overlay.is-visible {
        display: block;
      }
      #prodata-assist-inline-ocr-overlay .pa-ocr-hint {
        position: absolute;
        left: 50%;
        top: 16px;
        transform: translateX(-50%);
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(2, 28, 23, 0.9);
        color: #f4fff9;
        border: 1px solid rgba(37, 211, 102, 0.22);
        box-shadow: 0 10px 24px rgba(0, 0, 0, .22);
        font: 500 12px/1 "Plus Jakarta Sans", system-ui, sans-serif;
        pointer-events: none;
      }
      #prodata-assist-inline-ocr-overlay .pa-ocr-selection {
        position: absolute;
        display: none;
        border: 1px solid rgba(255, 255, 255, 0.92);
        background: rgba(37, 211, 102, 0.08);
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18);
        border-radius: 10px;
        pointer-events: none;
      }
      #prodata-assist-inline-opener.pulse-complete {
        animation: subtlePulse .72s cubic-bezier(.22, 1, .36, 1) 1;
      }
      #prodata-assist-inline {
        position: fixed;
        right: 18px;
        bottom: 152px;
        left: auto;
        top: auto;
        width: min(332px, calc(100vw - 28px));
        max-height: calc(100vh - 24px);
        display: flex;
        flex-direction: column;
        z-index: 999999;
        background: linear-gradient(180deg, rgba(2, 28, 23, 0.7), rgba(4, 42, 34, 0.54));
        color: #f4fff9;
        border: 1px solid rgba(37, 211, 102, 0.26);
        border-radius: 14px;
        box-shadow: 0 18px 42px rgba(0, 0, 0, .32), inset 0 1px 0 rgba(255, 255, 255, .07);
        backdrop-filter: blur(10px) saturate(150%); /* [IMPROVED] Card com blur sutil. */
        -webkit-backdrop-filter: blur(10px) saturate(150%);
        font: 400 14px/1.5 "Plus Jakarta Sans", system-ui, sans-serif; /* [IMPROVED] Interface mais profissional. */
        overflow: hidden;
        opacity: 0;
        transform: none;
        transform-origin: bottom right;
      }
      #prodata-assist-inline.pa-open {
        opacity: 1;
        transform: none;
      }
      #prodata-assist-inline.pa-closing {
        opacity: 0;
        pointer-events: none;
        transform: none;
      }
      #prodata-assist-inline .pa-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 9px 11px;
        background: linear-gradient(135deg, rgba(0, 92, 75, 0.92), rgba(18, 140, 126, 0.92)); /* [IMPROVED] Header translucido. */
        border-bottom: 1px solid rgba(37, 211, 102, 0.18);
        backdrop-filter: blur(16px); /* [IMPROVED] Header com blur. */
        -webkit-backdrop-filter: blur(16px);
        cursor: default;
        user-select: text;
        touch-action: auto;
      }
      #prodata-assist-inline .pa-title {
        font-family: "Plus Jakarta Sans", system-ui, sans-serif; /* [FONT] */
        font-size: 14px; /* [FONT] */
        font-weight: 700; /* [FONT] */
        letter-spacing: -0.02em; /* [FONT] */
      }
      #prodata-assist-inline .pa-head-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      #prodata-assist-inline .pa-logo-shell {
        width: 38px;
        height: 38px;
        min-width: 38px;
        border-radius: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 0;
        box-shadow: none;
        overflow: hidden;
      }
      #prodata-assist-inline .pa-logo {
        width: 44px;
        height: 44px;
        object-fit: contain;
        display: block;
        filter: drop-shadow(0 1px 4px rgba(255, 255, 255, 0.08));
      }
      #prodata-assist-inline .pa-status {
        font-family: "Plus Jakarta Sans", system-ui, sans-serif; /* [FONT] */
        color: rgba(255, 255, 255, 0.65); /* [FONT] */
        font-size: 11px; /* [FONT] */
        font-weight: 400; /* [FONT] */
        letter-spacing: 0.02em; /* [FONT] */
        line-height: 1.38;
      }
      #prodata-assist-inline .pa-head-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #prodata-assist-inline .pa-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        min-width: 30px;
        min-height: 30px;
        padding: 0;
        border-radius: 999px; /* [IMPROVED] Botao pill/circular. */
        border: 1px solid rgba(37, 211, 102, 0.24);
        background: rgba(2, 28, 23, 0.58);
        color: #dcfce7;
        cursor: pointer;
        font-family: "Plus Jakarta Sans", system-ui, sans-serif;
        line-height: 1;
      }
      #prodata-assist-inline .pa-close svg {
        display: block;
        width: 13px;
        height: 13px;
        stroke: currentColor;
        stroke-width: 2.2;
        stroke-linecap: round;
      }
      #prodata-assist-inline .pa-close:hover {
        opacity: .92; /* [IMPROVED] Hover menos generico. */
        transform: none;
      }
      #prodata-assist-inline .pa-body {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow-y: auto;
        padding: 9px 11px 11px;
      }
      #prodata-assist-inline .pa-label {
        font-family: "Plus Jakarta Sans", system-ui, sans-serif; /* [FONT] */
        color: rgba(255, 255, 255, 0.45); /* [FONT] */
        font-size: 11px; /* [FONT] */
        font-weight: 600; /* [FONT] */
        margin-bottom: 2px;
        text-transform: uppercase;
        letter-spacing: 0.12px; /* [FONT] */
      }
      #prodata-assist-inline .pa-update-template {
        display: none;
        margin-bottom: 6px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(37, 211, 102, 0.16);
      }
      #prodata-assist-inline.pa-support-group .pa-update-template {
        display: block;
      }
      #prodata-assist-inline .pa-template-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 6px;
      }
      #prodata-assist-inline .pa-template-generate {
        min-height: 30px;
        border: 1px solid rgba(37, 211, 102, 0.42);
        background: rgba(37, 211, 102, 0.16);
        color: white;
        border-radius: 999px;
        padding: 0 14px;
        font: 500 12px/1 "Plus Jakarta Sans", system-ui, sans-serif;
        cursor: pointer;
        transition: all .25s ease;
      }
      #prodata-assist-inline .pa-template-generate:hover {
        background: rgba(62, 190, 109, 0.28);
        transform: translateY(-1px);
      }
      #prodata-assist-inline .pa-template-fields {
        display: grid;
        grid-template-columns: 1fr 92px;
        gap: 8px;
      }
      #prodata-assist-inline .pa-template-fields label {
        display: grid;
        gap: 4px;
      }
      #prodata-assist-inline .pa-version-field {
        grid-column: 1 / -1;
      }
      #prodata-assist-inline .pa-template-fields span {
        color: rgba(255, 255, 255, 0.56);
        font: 400 11px/1.3 "Plus Jakarta Sans", system-ui, sans-serif;
      }
      #prodata-assist-inline .pa-template-fields input {
        width: 100%;
        height: 34px;
        border: 1px solid rgba(37, 211, 102, 0.18);
        border-radius: 10px;
        background: rgba(5, 46, 37, 0.5);
        color: #f4fff9;
        outline: none;
        padding: 0 10px;
        font: 400 13px/1.3 "Plus Jakarta Sans", system-ui, sans-serif;
        transition: border-color .25s ease, background .25s ease;
      }
      #prodata-assist-inline .pa-template-fields input:focus {
        border-color: rgba(37, 211, 102, 0.5);
        background: rgba(5, 46, 37, 0.62);
      }
      #prodata-assist-inline .pa-suggestion {
        position: relative; /* [IMPROVED] Suporte para tail triangular. */
        min-height: 48px;
        width: calc(100% - 16px);
        max-width: calc(100% - 16px);
        max-height: none;
        overflow: visible;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        background: rgba(5, 46, 37, 0.5);
        border: 1px solid rgba(37, 211, 102, 0.18);
        border-radius: 12px 12px 4px 12px; /* [IMPROVED] Bolha recebida com canto caracteristico. */
        margin: 0 auto;
        padding: 8px 12px 10px;
        color: #f4fff9;
        font: 400 13.5px/1.56 "Roboto", system-ui, sans-serif; /* [IMPROVED] Fonte de mensagens. */
        opacity: .95;
        backdrop-filter: blur(10px); /* [IMPROVED] Card translucido. */
        -webkit-backdrop-filter: blur(10px);
        transition: none;
        will-change: transform, opacity;
      }
      #prodata-assist-inline .pa-suggestion::before {
        content: ""; /* [IMPROVED] Cauda triangular da bolha. */
        position: absolute;
        left: -6px;
        bottom: 8px;
        width: 12px;
        height: 12px;
        background: rgba(5, 46, 37, 0.5);
        border-left: 1px solid rgba(37, 211, 102, 0.18);
        border-bottom: 1px solid rgba(37, 211, 102, 0.18);
        transform: rotate(45deg);
      }
      #prodata-assist-inline .pa-suggestion:hover {
        opacity: 1; /* [IMPROVED] Hover de bolha. */
        box-shadow: 0 2px 8px rgba(0, 0, 0, .15);
      }
      #prodata-assist-inline .pa-suggestion.pa-pop,
      #prodata-assist-inline .pa-suggestion.pa-expand,
      #prodata-assist-inline .pa-suggestion.pa-contract {
        animation: none !important;
      }
      #prodata-assist-inline .pa-suggestion::-webkit-scrollbar {
        width: 4px; /* [IMPROVED] Scrollbar customizada. */
      }
      #prodata-assist-inline .pa-suggestion::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, .15);
        border-radius: 999px;
      }
      #prodata-assist-inline .pa-suggestion::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, .3);
      }
      #prodata-assist-inline .pa-source-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 4px;
      }
      #prodata-assist-inline .pa-source-row[hidden] {
        display: none !important;
      }
      #prodata-assist-inline .pa-source-options {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #prodata-assist-inline .pa-source-option {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        min-width: 86px;
        border-radius: 999px;
        padding: 0 14px;
        border: 1px solid rgba(37, 211, 102, 0.18);
        background: rgba(5, 46, 37, 0.42);
        color: rgba(255, 255, 255, 0.72);
        font: 700 10.5px/1 "Plus Jakarta Sans", system-ui, sans-serif;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        cursor: pointer;
        transform: translateZ(0);
        backface-visibility: hidden;
        -webkit-font-smoothing: antialiased;
        text-rendering: geometricPrecision;
        outline: none;
      }
      #prodata-assist-inline .pa-source-option:hover {
        background: rgba(9, 68, 55, 0.58);
        color: rgba(255, 255, 255, 0.92);
      }
      #prodata-assist-inline .pa-source-option.is-active {
        background: linear-gradient(135deg, rgba(14, 126, 108, 0.9), rgba(20, 175, 109, 0.88));
        border-color: rgba(37, 211, 102, 0.34);
        color: white;
        box-shadow: 0 6px 18px rgba(18, 140, 126, 0.22);
      }
      #prodata-assist-inline .pa-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 16px;
      }
      #prodata-assist-inline .pa-typing {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 12px;
        width: fit-content;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.96);
        opacity: 0;
      }
      #prodata-assist-inline .pa-typing.is-visible {
      }
      #prodata-assist-inline .pa-typing-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #7a8f8a;
      }
      #prodata-assist-inline .pa-typing-dot:nth-child(2) {
        animation-delay: 140ms;
      }
      #prodata-assist-inline .pa-typing-dot:nth-child(3) {
        animation-delay: 280ms;
      }
      #prodata-assist-inline .pa-accept {
        position: relative;
        overflow: hidden;
        border: 1px solid rgba(37, 211, 102, 0.48);
        background: linear-gradient(135deg, rgba(37, 211, 102, 0.94), rgba(18, 140, 126, 0.92));
        color: white;
        border-radius: 999px; /* [IMPROVED] CTA pill. */
        padding: 9px 24px; /* [BUTTON] */
        font-family: "Plus Jakarta Sans", system-ui, sans-serif; /* [BUTTON] */
        font-size: 13px; /* [BUTTON] */
        font-weight: 500; /* [BUTTON] */
        letter-spacing: 0.01em; /* [BUTTON] */
        cursor: pointer;
        box-shadow: 0 8px 20px rgba(18, 140, 126, .26);
        transition: none; /* [BUTTON] */
      }
      #prodata-assist-inline .pa-accept::after {
        content: '';
        position: absolute;
        inset: -1px;
        border-radius: inherit;
        background: radial-gradient(circle at 50% 40%, rgba(255, 255, 255, .22), rgba(255, 255, 255, .1) 30%, rgba(255, 255, 255, 0) 72%);
        opacity: 0;
        transform: scale(.92);
        pointer-events: none;
        transition: none;
      }
      #prodata-assist-inline .pa-accept:hover {
        background: linear-gradient(135deg, rgba(62, 190, 109, 1), rgba(31, 154, 139, 0.98)); /* [BUTTON] */
        transform: none; /* [BUTTON] */
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.12) inset,
          0 0 10px rgba(255, 255, 255, 0.16),
          0 4px 12px rgba(37, 211, 102, 0.3); /* [BUTTON] */
      }
      #prodata-assist-inline .pa-accept:active {
        transform: none; /* [BUTTON] */
        transition: none; /* [BUTTON] */
      }
      #prodata-assist-inline .pa-accept.is-flashing {
        color: rgba(255, 255, 255, 0.98);
        border-color: rgba(255, 255, 255, 0.62);
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.18) inset,
          0 0 8px rgba(255, 255, 255, 0.18),
          0 8px 20px rgba(18, 140, 126, .24);
        filter: none;
      }
      #prodata-assist-inline .pa-accept.is-flashing::after {
        opacity: 1;
        transform: none;
      }
      #prodata-assist-inline .pa-accept.is-flashing:hover {
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.2) inset,
          0 0 10px rgba(255, 255, 255, 0.2),
          0 8px 20px rgba(18, 140, 126, .24);
      }
      #prodata-assist-inline.pa-waiting .pa-suggestion {
        color: rgba(186, 205, 197, 0.95);
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);
    panel.setAttribute('data-version', widgetVersion);
    opener = document.createElement('button');
    opener.id = openerId;
    opener.type = 'button';
    opener.setAttribute('data-version', widgetVersion);
    // [IMPROVED] Icone de agente no lugar de texto generico no estado minimizado.
    opener.innerHTML = `
      <img class="pa-opener-logo" src="__ESTAGIARIO_LOGO__" alt="">
    `;
    opener.title = 'Abrir Estagiário';
    opener.setAttribute('aria-label', 'Abrir Estagiário');
    document.body.appendChild(opener);
    const ocrButton = document.createElement('button');
    ocrButton.id = 'prodata-assist-inline-ocr';
    ocrButton.type = 'button';
    ocrButton.title = 'Selecionar area para OCR';
    ocrButton.setAttribute('aria-label', 'Selecionar area para OCR');
    ocrButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 7V5h2"></path>
        <path d="M17 5h2v2"></path>
        <path d="M19 17v2h-2"></path>
        <path d="M7 19H5v-2"></path>
        <rect x="8" y="8" width="8" height="8" rx="1.8"></rect>
      </svg>
      <span>OCR</span>
    `;
    document.body.appendChild(ocrButton);
    const ocrOverlay = document.createElement('div');
    ocrOverlay.id = 'prodata-assist-inline-ocr-overlay';
    ocrOverlay.innerHTML = `
      <div class="pa-ocr-hint">Arraste para selecionar a area da imagem</div>
      <div class="pa-ocr-selection"></div>
    `;
    document.body.appendChild(ocrOverlay);
    const ocrSelection = ocrOverlay.querySelector('.pa-ocr-selection');
    let ocrDragging = false;
    let ocrStartX = 0;
    let ocrStartY = 0;
    let ocrRect = null;
    window.__prodataAssistOcrRequest = window.__prodataAssistOcrRequest || 0;
    window.__prodataAssistOcrSelection = window.__prodataAssistOcrSelection || null;
    const hideOcrOverlay = () => {
      ocrDragging = false;
      ocrRect = null;
      ocrOverlay.classList.remove('is-visible');
      ocrOverlay.setAttribute('aria-hidden', 'true');
      ocrSelection.style.display = 'none';
      ocrButton.classList.remove('is-active');
      ocrButton.classList.remove('is-flashing');
      if (panel) {
        panel.style.visibility = '';
      }
      if (opener) {
        opener.style.visibility = '';
      }
    };
    const flashOcrButton = () => {
      ocrButton.classList.remove('is-flashing');
      void ocrButton.offsetWidth;
      ocrButton.classList.add('is-flashing');
      if (ocrButton.__prodataFlashTimer) {
        window.clearTimeout(ocrButton.__prodataFlashTimer);
      }
      ocrButton.__prodataFlashTimer = window.setTimeout(() => {
        ocrButton.classList.remove('is-flashing');
        ocrButton.__prodataFlashTimer = null;
      }, 420);
    };
    const showOcrOverlay = () => {
      if (!getOcrTargetRect()) return;
      ocrRect = null;
      ocrDragging = false;
      if (panel) {
        panel.style.visibility = 'hidden';
      }
      if (opener) {
        opener.style.visibility = 'hidden';
      }
      ocrOverlay.classList.add('is-visible');
      ocrOverlay.setAttribute('aria-hidden', 'false');
      ocrSelection.style.display = 'none';
      ocrButton.classList.add('is-active');
      flashOcrButton();
    };
    const setOcrSelectionBox = (x1, y1, x2, y2) => {
      const left = Math.max(0, Math.min(x1, x2));
      const top = Math.max(0, Math.min(y1, y2));
      const width = Math.max(0, Math.abs(x2 - x1));
      const height = Math.max(0, Math.abs(y2 - y1));
      ocrRect = {left, top, width, height};
      ocrSelection.style.display = width > 4 && height > 4 ? 'block' : 'none';
      ocrSelection.style.left = `${left}px`;
      ocrSelection.style.top = `${top}px`;
      ocrSelection.style.width = `${width}px`;
      ocrSelection.style.height = `${height}px`;
    };
    const finalizeOcrSelection = () => {
      if (!ocrRect || ocrRect.width < 12 || ocrRect.height < 12) {
        hideOcrOverlay();
        return;
      }
      window.__prodataAssistOcrSelection = {
        x: ocrRect.left,
        y: ocrRect.top,
        width: ocrRect.width,
        height: ocrRect.height,
      };
      window.__prodataAssistOcrRequest = Number(window.__prodataAssistOcrRequest || 0) + 1;
      hideOcrOverlay();
    };
    ocrButton.addEventListener('click', () => {
      flashOcrButton();
      showOcrOverlay();
    });
    ocrOverlay.addEventListener('pointerdown', (event) => {
      if (!ocrOverlay.classList.contains('is-visible') || (event.button !== undefined && event.button !== 0)) return;
      ocrDragging = true;
      ocrStartX = event.clientX;
      ocrStartY = event.clientY;
      setOcrSelectionBox(ocrStartX, ocrStartY, ocrStartX, ocrStartY);
      ocrOverlay.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    ocrOverlay.addEventListener('pointermove', (event) => {
      if (!ocrDragging) return;
      setOcrSelectionBox(ocrStartX, ocrStartY, event.clientX, event.clientY);
      event.preventDefault();
    });
    ocrOverlay.addEventListener('pointerup', (event) => {
      if (!ocrDragging) return;
      ocrDragging = false;
      setOcrSelectionBox(ocrStartX, ocrStartY, event.clientX, event.clientY);
      finalizeOcrSelection();
      event.preventDefault();
    });
    ocrOverlay.addEventListener('pointercancel', hideOcrOverlay);
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (ocrOverlay.classList.contains('is-visible')) {
        hideOcrOverlay();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    window.__prodataAssistApplyFloatingAnchor = () => {
      const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
        if (!el || el === opener || el.closest('#prodata-assist-inline')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 28 || rect.height < 28) return false;
        if (rect.width > 92 || rect.height > 92) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (rect.right < window.innerWidth - 140) return false;
        if (rect.top < window.innerHeight * 0.45) return false;
        return true;
      });
      const sortedButtons = visibleButtons
        .slice()
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const scrollButton = sortedButtons.find((el) => {
          const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.toLowerCase();
          return text.includes('baixo')
            || text.includes('recent')
            || text.includes('nova')
            || text.includes('unread')
            || text.includes('mensagem');
        }) || null;
      const micButton = sortedButtons
        .slice()
        .reverse()
        .find((el) => {
          const rect = el.getBoundingClientRect();
          const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.toLowerCase();
          return text.includes('micro')
            || text.includes('audio')
            || text.includes('voz')
            || text.includes('voice')
            || rect.width >= 42
            || rect.height >= 42;
        }) || null;

      const openerSize = 58;
      const panelGap = 24;
      const footer = document.querySelector('footer');
      const footerRect = footer ? footer.getBoundingClientRect() : null;
      let right = 18;
      let bottom = footerRect ? Math.max(18, window.innerHeight - footerRect.top + 10) : 96;

      if (micButton) {
        const micRect = micButton.getBoundingClientRect();
        right = Math.max(12, window.innerWidth - micRect.right);
        bottom = Math.max(bottom, window.innerHeight - micRect.top + 12);
      }

      if (scrollButton) {
        const scrollRect = scrollButton.getBoundingClientRect();
        right = Math.max(12, window.innerWidth - scrollRect.right - 10);
        const gapAboveScroll = 64;
        const desiredBottom = window.innerHeight - scrollRect.top + gapAboveScroll;
        const openerTop = window.innerHeight - bottom - openerSize;
        if (openerTop <= scrollRect.top + gapAboveScroll) {
          bottom = Math.max(bottom, desiredBottom);
        }
      }

      opener.style.left = 'auto';
      opener.style.top = 'auto';
      opener.style.right = `${right}px`;
      opener.style.bottom = `${bottom}px`;
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      panel.style.right = `${right}px`;
      const viewportMargin = 12;
      const panelHeight = Math.min(
        panel.offsetHeight || panel.scrollHeight || 0,
        Math.max(0, window.innerHeight - (viewportMargin * 2))
      );
      const desiredPanelBottom = bottom + openerSize + panelGap;
      const maxPanelBottom = Math.max(viewportMargin, window.innerHeight - panelHeight - viewportMargin);
      panel.style.bottom = `${Math.max(viewportMargin, Math.min(desiredPanelBottom, maxPanelBottom))}px`;
    };
    const applyFloatingAnchor = () => window.__prodataAssistApplyFloatingAnchor && window.__prodataAssistApplyFloatingAnchor();
    const hidden = localStorage.getItem(hiddenStateKey) === '1';
    if (hidden) {
      panel.style.display = 'none';
      opener.style.display = 'block';
    }
    const syncAnchorAndOcr = () => {
      applyFloatingAnchor();
      if (window.__prodataAssistSyncOcrControls) {
        window.__prodataAssistSyncOcrControls();
      }
      const mediaOpen = isMediaViewerOpen();
      if (!mediaOpen) {
        const hidden = localStorage.getItem(hiddenStateKey) === '1';
        const panelHidden = !panel || panel.style.display === 'none';
        const openerHidden = !opener || opener.style.display === 'none';
        if (hidden && panelHidden && openerHidden && opener) {
          opener.style.display = 'block';
        }
        if (!hidden && panelHidden) {
          ensurePanelOpen();
        }
      }
    };
    const scheduleAnchorAndOcrSync = () => {
      window.setTimeout(syncAnchorAndOcr, 0);
    };
    const isElementVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isMediaViewerOpen = () => {
      const markers = Array.from(document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], [data-testid*="viewer"], [data-testid*="media"], [data-testid*="modal"]'
      ));
      return markers.some((element) => {
        if (!element || element === panel || element.contains(panel)) return false;
        if (!isElementVisible(element)) return false;
        const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.id || ''} ${element.className || ''}`.toLowerCase();
        if (label.includes('dados do contato') || label.includes('contato') || label.includes('contact')) return false;
        const hasMedia = Boolean(element.querySelector('img, video, canvas, svg'));
        if (label.includes('image') || label.includes('imagem') || label.includes('foto') || label.includes('photo') || label.includes('media') || label.includes('viewer') || label.includes('visualizador')) {
          const rect = element.getBoundingClientRect();
          return hasMedia && rect.width >= window.innerWidth * 0.45 && rect.height >= window.innerHeight * 0.25;
        }
        const rect = element.getBoundingClientRect();
        const coversScreen = rect.width >= window.innerWidth * 0.6 && rect.height >= window.innerHeight * 0.45;
        return coversScreen && hasMedia;
      });
    };
    const getVisibleAreaRect = (rect) => {
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      return {left, top, width, height, area: width * height};
    };
    const getOcrTargetRect = () => {
      const candidates = Array.from(document.querySelectorAll('img, video, canvas')).filter((element) => {
        if (!element || !isElementVisible(element)) return false;
        if (element.closest('#prodata-assist-inline') || element.closest('#prodata-assist-inline-opener')) return false;
        if (element.closest('[aria-label*="Dados do contato"], [aria-label*="Contato"], [data-testid*="drawer"], [data-testid*="sidebar"]')) return false;
        const modalHost = element.closest('[role="dialog"], [aria-modal="true"], [data-testid*="viewer"], [data-testid*="media"], [data-testid*="modal"]');
        if (!modalHost) return false;
        if (modalHost.closest('[data-testid*="conversation-panel-messages"], #main [data-id]')) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 180 || rect.height <= 180) return false;
        const visibleRect = getVisibleAreaRect(rect);
        const totalArea = Math.max(1, rect.width * rect.height);
        return visibleRect.width >= 180
          && visibleRect.height >= 180
          && visibleRect.area / totalArea >= 0.45;
      });
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });
      const target = candidates[0];
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      const visibleRect = getVisibleAreaRect(rect);
      return {
        x: visibleRect.left,
        y: visibleRect.top,
        width: visibleRect.width,
        height: visibleRect.height,
      };
    };
    const hasOpenMediaStage = () => Boolean(getOcrTargetRect()) || isMediaViewerOpen();
    window.__prodataAssistIsMediaViewerOpen = () => Boolean(getOcrTargetRect()) || isMediaViewerOpen();
    window.__prodataAssistGetOcrState = () => ({
      open: Boolean(getOcrTargetRect()),
      selection: window.__prodataAssistOcrSelection || null,
      request: Number(window.__prodataAssistOcrRequest || 0),
      target: getOcrTargetRect(),
    });
    window.__prodataAssistSyncOcrControls = () => {
      const targetRect = getOcrTargetRect();
      if (!targetRect) {
        hideOcrOverlay();
        ocrButton.classList.remove('is-visible');
        ocrButton.style.display = 'none';
        if (opener) {
          opener.style.display = localStorage.getItem(hiddenStateKey) === '1' ? 'block' : 'none';
        }
        return;
      }
      if (hasOpenMediaStage() && opener) {
        opener.style.display = 'none';
      }
      ocrButton.classList.add('is-visible');
      ocrButton.style.display = 'inline-flex';
      const openerRight = parseFloat(opener?.style.right || '18') || 18;
      const openerBottom = parseFloat(opener?.style.bottom || '96') || 96;
      ocrButton.style.right = `${openerRight}px`;
      ocrButton.style.bottom = `${openerBottom}px`;
      ocrButton.style.left = 'auto';
      ocrButton.style.top = 'auto';
    };
    let viewerObserver = null;
    let viewerCheckTimer = null;
    const scheduleViewerCheck = () => {
      if (viewerCheckTimer) window.clearTimeout(viewerCheckTimer);
      viewerCheckTimer = window.setTimeout(() => {
        viewerCheckTimer = null;
        if (hasOpenMediaStage()) {
          minimizePanel();
        }
        if (window.__prodataAssistSyncOcrControls) {
          window.__prodataAssistSyncOcrControls();
        }
      }, 120);
    };
    if (document.body && !viewerObserver) {
      viewerObserver = new MutationObserver(scheduleViewerCheck);
      viewerObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-label', 'role', 'data-testid', 'aria-modal'],
      });
      scheduleViewerCheck();
    }
    scheduleAnchorAndOcrSync();
    window.setInterval(syncAnchorAndOcr, 1200);
    const resetProgressRing = (mode) => {
      const progressRing = opener.querySelector('.pa-opener-ring-progress');
      const fullRing = opener.querySelector('.pa-opener-ring-full');
      if (opener.__prodataRingRaf) {
        window.cancelAnimationFrame(opener.__prodataRingRaf);
        opener.__prodataRingRaf = null;
      }
      if (progressRing) {
        progressRing.style.animation = 'none';
        progressRing.style.opacity = '0';
      }
      if (fullRing) {
        fullRing.style.opacity = mode === 'full' ? '1' : '0';
      }
    };
    const showLoading = () => {
      opener.dataset.loadingPhase = 'loading';
      resetProgressRing('empty');
    };
    const completeLoading = () => {
      opener.dataset.loadingPhase = 'idle';
      resetProgressRing('empty');
    };
    const flashAcceptButton = () => {
      const acceptBtn = panel.querySelector('.pa-accept');
      if (!acceptBtn) return;
      acceptBtn.classList.remove('is-flashing');
      void acceptBtn.offsetWidth;
      acceptBtn.classList.add('is-flashing');
      if (acceptBtn.__prodataFlashTimer) {
        window.clearTimeout(acceptBtn.__prodataFlashTimer);
      }
      acceptBtn.__prodataFlashTimer = window.setTimeout(() => {
        acceptBtn.classList.remove('is-flashing');
        acceptBtn.__prodataFlashTimer = null;
      }, 420);
    };
    const flashSuggestionChange = () => {};
    panel.querySelector('.pa-close').addEventListener('click', () => {
      minimizePanel();
    });
    const head = panel.querySelector('.pa-head');
    opener.addEventListener('click', () => {
      localStorage.setItem(hiddenStateKey, '0');
      applyFloatingAnchor();
      panel.classList.remove('pa-open');
      ensurePanelOpen();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (panel.style.display === 'none') return;
      minimizePanel();
    }, true);
    const setSuggestion = (text, status) => {
      window.__prodataAssistSuggestion = text || '';
      panel.classList.toggle('pa-waiting', !text);
      panel.querySelector('.pa-status').textContent = status || '';
      const sourceRow = panel.querySelector('.pa-source-row');
      const sourceOptions = panel.querySelector('.pa-source-options');
      panel.dataset.selectedSource = '';
      if (sourceOptions) {
        sourceOptions.innerHTML = '';
      }
      if (sourceRow) {
        sourceRow.hidden = true;
      }
      const suggestion = panel.querySelector('.pa-suggestion');
      flashSuggestionChange();
      suggestion.textContent = text || '';
      panel.querySelector('.pa-accept').disabled = !text;
      panel.querySelector('.pa-accept').style.opacity = text ? '1' : '.45';
      const typing = panel.querySelector('.pa-typing');
      if (typing) {
        typing.classList.remove('is-visible');
        typing.hidden = true;
      }
    };
    const fillComposeBox = (box, text) => {
      if (!box) return;
      const value = String(text || '');
      box.focus();
      if (box.isContentEditable) {
        const selection = window.getSelection ? window.getSelection() : null;
        const range = document.createRange ? document.createRange() : null;
        if (selection && range) {
          range.selectNodeContents(box);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        try {
          document.execCommand('selectAll', false);
        } catch (error) {}
        try {
          document.execCommand('delete', false);
        } catch (error) {}
        try {
          if (typeof box.replaceChildren === 'function') {
            box.replaceChildren();
          }
        } catch (error) {}
        box.innerHTML = '';
        box.textContent = '';
      } else if ('value' in box) {
        box.value = '';
      }
      if (box.isContentEditable) {
        let inserted = false;
        try {
          inserted = Boolean(document.execCommand('insertText', false, value));
        } catch (error) {
          inserted = false;
        }
        if (!inserted) {
          try {
            const fragment = document.createDocumentFragment();
            const lines = value.split('\n');
            lines.forEach((line, index) => {
              if (index > 0) fragment.appendChild(document.createElement('br'));
              fragment.appendChild(document.createTextNode(line));
            });
            if (typeof box.replaceChildren === 'function') {
              box.replaceChildren(fragment);
            } else {
              box.appendChild(fragment);
            }
          } catch (error) {
            box.textContent = value;
          }
        }
      } else if ('value' in box) {
        box.value = value;
      }
      box.focus();
      box.dispatchEvent(new InputEvent('input', {bubbles:true, cancelable:true, inputType:'insertReplacementText', data:value}));
      box.dispatchEvent(new Event('change', {bubbles:true}));
    };
    const getComposeBox = () => (
      document.querySelector('[data-testid="conversation-compose-box-input"][contenteditable="true"]')
      || Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find((el) =>
        /Digite uma mensagem/i.test(el.getAttribute('aria-label') || '')
      )
    );
    const normalizeDate = (value) => {
      const digits = (value || '').replace(/\D/g, '').slice(0, 8);
      if (digits.length <= 2) return digits;
      if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
      return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    };
    const normalizeTime = (value) => {
      const digits = (value || '').replace(/\D/g, '').slice(0, 4);
      if (digits.length <= 2) return digits;
      return `${digits.slice(0, 2)}:${digits.slice(2)}`;
    };
    const parseTimeParts = (value) => {
      const digits = (value || '').replace(/\D/g, '').slice(0, 4);
      if (digits.length < 2) return null;
      const hour = parseInt(digits.slice(0, 2), 10);
      const minute = digits.length >= 4 ? parseInt(digits.slice(2, 4), 10) : 0;
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      return {hour, minute};
    };
    const getGreetingFromTime = (value) => {
      const parts = parseTimeParts(value);
      const currentHour = parts === null ? new Date().getHours() : parts.hour;
      if (currentHour < 12) return 'Bom dia';
      if (currentHour < 18) return 'Boa Tarde';
      return 'Boa Noite';
    };
    const formatTimeLabel = (value) => {
      const parts = parseTimeParts(value);
      if (parts === null) return '';
      if (parts.minute === 0) return `${parts.hour} h`;
      return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}h`;
    };
    const formatVersionLabel = (value) => {
      const version = (value || '').trim();
      if (!version) return 'SIG Versão Oficial (Nº: 0.0)';
      if (/^sig\s+vers[aã]o\s+oficial/i.test(version)) return version;
      if (/^\d+(?:[.,]\d+)?$/.test(version)) {
        const normalized = version.replace(',', '.');
        return `SIG Versão Oficial (Nº: ${normalized.includes('.') ? normalized : `${normalized}.0`})`;
      }
      return `Versão ${version}`;
    };
    const buildUpdateNotice = () => {
      const dateInput = panel.querySelector('.pa-update-date');
      const timeInput = panel.querySelector('.pa-update-time');
      const versionInput = panel.querySelector('.pa-update-version');
      dateInput.value = normalizeDate(dateInput.value);
      timeInput.value = normalizeTime(timeInput.value);
      const updateDate = dateInput.value.trim() || '28/05/2026';
      const updateTime = timeInput.value.trim() || '15:00';
      const version = versionInput.value.trim() || 'Sig Integrações Rest 4.0.113';
      const greeting = getGreetingFromTime(updateTime);
      const timeLabel = formatTimeLabel(updateTime) || updateTime;
      const versionLabel = formatVersionLabel(version);
      return [
        `*${greeting}, Informamos que a atualização do sistema Prodata será realizada às ${timeLabel} do dia ${updateDate}.*`,
        '',
        'Durante esse período, o sistema ficará indisponível por aproximadamente 20 a 40 minutos.',
        '',
        `*${versionLabel}*`,
        '',
        'Agradecemos a compreensão de todos.'
      ].join('\n');
    };
    panel.querySelector('.pa-update-date').addEventListener('input', (event) => {
      event.target.value = normalizeDate(event.target.value);
    });
    panel.querySelector('.pa-update-time').addEventListener('input', (event) => {
      event.target.value = normalizeTime(event.target.value);
    });
    panel.querySelector('.pa-template-generate').addEventListener('click', () => {
      showLoading();
      const typing = panel.querySelector('.pa-typing');
      if (typing) {
        typing.hidden = false;
      }
      setSuggestion(buildUpdateNotice(), '');
      completeLoading();
    });
    panel.querySelector('.pa-accept').addEventListener('click', () => {
      const text = window.__prodataAssistSuggestion || '';
      const box = getComposeBox();
      if (!text || !box) return;
      flashAcceptButton();
      fillComposeBox(box, text);
    });
    window.addEventListener('resize', () => {
      applyFloatingAnchor();
    });
    head.addEventListener('dragstart', (event) => event.preventDefault());
  }
  if (panel) panel.setAttribute('data-version', widgetVersion);
  if (opener) opener.setAttribute('data-version', widgetVersion);
  if (window.__prodataAssistApplyFloatingAnchor) {
    window.__prodataAssistApplyFloatingAnchor();
  }
  minimizePanel();
  if (Boolean(typeof getOcrTargetRect === 'function' && getOcrTargetRect())) {
    if (opener) opener.style.display = 'none';
  } else if (opener) {
    opener.style.display = 'block';
    opener.style.visibility = 'visible';
    opener.style.opacity = '1';
  }
})()
"""
PANEL_JS = PANEL_JS.replace("__ESTAGIARIO_LOGO__", ESTAGIARIO_LOGO_SRC)


UPDATE_PANEL_JS = r"""
((payload) => {
  const panel = document.getElementById('prodata-assist-inline');
  if (!panel) return false;
  const labelMap = {
    mimo: 'MiMo',
    mimo_visao: 'MiMo',
    qwen: 'Qwen',
    qwen_local: 'Qwen Local',
    banco_local: 'Local',
    heuristica: 'Local',
    fallback_minimo: 'Local'
  };
  panel.classList.toggle('pa-support-group', Boolean(payload.support_group));
  panel.classList.toggle('pa-waiting', !payload.suggestion);
  panel.querySelector('.pa-status').textContent = payload.status || '';
  const sourceRow = panel.querySelector('.pa-source-row');
  const sourceOptions = panel.querySelector('.pa-source-options');
  const suggestion = panel.querySelector('.pa-suggestion');
  const accept = panel.querySelector('.pa-accept');
  const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const deduped = [];
  const seen = new Set();
  rawCandidates.forEach((candidate) => {
    if (!candidate) return;
    const source = String(candidate.source || '').trim();
    const text = String(candidate.text || '').trim();
    if (!source || !text || seen.has(source)) return;
    seen.add(source);
    deduped.push(candidate);
  });
  if (!deduped.length && payload.suggestion) {
    const fallbackSource = String(payload.source || '').trim() || 'fallback_minimo';
    deduped.push({source: fallbackSource, text: String(payload.suggestion || '').trim(), winner: true});
  }
  const winner = deduped.find((candidate) => candidate && candidate.winner) || deduped[0] || null;
  const preferredSource = String(payload.source || (winner && winner.source) || '').trim();
  let selected = deduped.find((candidate) => String(candidate.source || '').trim() === preferredSource) || winner || null;
  if (sourceOptions) {
    sourceOptions.innerHTML = '';
    deduped.forEach((candidate) => {
      const source = String(candidate.source || '').trim();
      const text = String(candidate.text || '').trim();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pa-source-option';
      button.textContent = (labelMap[source] || source).toUpperCase();
      if (selected && source === String(selected.source || '').trim()) {
        button.classList.add('is-active');
      }
      button.addEventListener('click', () => {
        panel.dataset.selectedSource = source;
        window.__prodataAssistSuggestion = text;
        suggestion.textContent = text;
        accept.disabled = !text;
        accept.style.opacity = text ? '1' : '.45';
        sourceOptions.querySelectorAll('.pa-source-option').forEach((node) => node.classList.remove('is-active'));
        button.classList.add('is-active');
      });
      sourceOptions.appendChild(button);
    });
  }
  if (sourceRow) {
    sourceRow.hidden = deduped.length === 0;
  }
  const selectedText = selected ? String(selected.text || '').trim() : '';
  const statusText = String(payload.status || '').trim();
  const fallbackText = String(payload.placeholder || '').trim() || statusText || 'gerando respostas...';
  const finalText = selectedText || payload.suggestion || fallbackText;
  window.__prodataAssistSuggestion = selectedText || payload.suggestion || '';
  suggestion.textContent = finalText;
  accept.disabled = !window.__prodataAssistSuggestion;
  accept.style.opacity = window.__prodataAssistSuggestion ? '1' : '.45';
  const typing = panel.querySelector('.pa-typing');
  if (typing) {
    const waiting = !window.__prodataAssistSuggestion;
    typing.classList.toggle('is-visible', waiting);
    typing.hidden = !waiting;
  }
  return true;
})(%s)
"""


SHOW_LOADING_JS = r"""
(() => {
  const opener = document.getElementById('prodata-assist-inline-opener');
  const panel = document.getElementById('prodata-assist-inline');
  if (opener) {
    if (opener.__prodataLoadingStageTimer) window.clearTimeout(opener.__prodataLoadingStageTimer);
    if (opener.__prodataLoadingDoneTimer) window.clearTimeout(opener.__prodataLoadingDoneTimer);
    opener.classList.remove('loading-finishing', 'loading-complete', 'pulse-complete');
    opener.classList.add('loading-active');
    const progressRing = opener.querySelector('.pa-opener-ring-progress');
    const fullRing = opener.querySelector('.pa-opener-ring-full');
    if (progressRing) {
      progressRing.style.animation = '';
      progressRing.style.opacity = '1';
      progressRing.style.strokeDashoffset = '0';
    }
    if (fullRing) {
      fullRing.style.opacity = '0';
    }
    opener.dataset.loadingPhase = 'loading';
    opener.__prodataLoadingStageTimer = window.setTimeout(() => {
      opener.classList.remove('loading-active');
      opener.classList.add('loading-finishing');
      opener.__prodataLoadingStageTimer = null;
    }, 1100);
  }
  if (panel) {
    const status = panel.querySelector('.pa-status');
    if (status) status.textContent = 'gerando respostas...';
    const suggestion = panel.querySelector('.pa-suggestion');
    if (suggestion && !String(window.__prodataAssistSuggestion || '').trim()) {
      suggestion.textContent = 'gerando respostas...';
    }
    const typing = panel.querySelector('.pa-typing');
    if (typing) {
      typing.hidden = false;
      typing.classList.add('is-visible');
    }
  }
  return true;
})()
"""


COMPLETE_LOADING_JS = r"""
(() => {
  const opener = document.getElementById('prodata-assist-inline-opener');
  const panel = document.getElementById('prodata-assist-inline');
  if (opener) {
    if (opener.__prodataLoadingStageTimer) {
      window.clearTimeout(opener.__prodataLoadingStageTimer);
      opener.__prodataLoadingStageTimer = null;
    }
    if (opener.__prodataLoadingDoneTimer) window.clearTimeout(opener.__prodataLoadingDoneTimer);
    const progressRing = opener.querySelector('.pa-opener-ring-progress');
    const fullRing = opener.querySelector('.pa-opener-ring-full');
    opener.classList.remove('loading-active');
    opener.classList.add('loading-finishing');
    if (progressRing) {
      progressRing.style.animation = 'none';
      progressRing.style.opacity = '0';
      progressRing.style.strokeDashoffset = '0';
    }
    if (fullRing) {
      fullRing.style.opacity = '1';
    }
    opener.dataset.loadingPhase = 'finishing';
    opener.__prodataLoadingDoneTimer = window.setTimeout(() => {
      opener.classList.remove('loading-finishing');
      opener.classList.add('loading-complete', 'pulse-complete');
      opener.dataset.loadingPhase = 'idle';
      window.setTimeout(() => {
        opener.classList.remove('loading-complete', 'pulse-complete');
        if (progressRing) {
          progressRing.style.opacity = '0';
          progressRing.style.strokeDashoffset = '0';
        }
        if (fullRing) {
          fullRing.style.opacity = '0';
        }
      }, 420);
      opener.__prodataLoadingDoneTimer = null;
    }, 380);
  }
  if (panel) {
    const status = panel.querySelector('.pa-status');
    if (status) status.textContent = '';
  }
  return true;
})()
"""


CHAT_TITLE_JS = r"""
(() => {
  const main = document.querySelector('#main');
  const headers = main ? [main.querySelector('header') || main] : Array.from(document.querySelectorAll('header'));
  const normalize = (text) => (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const candidates = [];
  headers.filter(Boolean).forEach((header) => {
    candidates.push((header.innerText || header.textContent || '').trim());
    header.querySelectorAll('[title], [aria-label], span, div').forEach((el) => {
      candidates.push((el.getAttribute('title') || '').trim());
      candidates.push((el.getAttribute('aria-label') || '').trim());
      candidates.push((el.textContent || '').trim());
    });
  });
  document.querySelectorAll('[aria-selected="true"], [aria-current="true"]').forEach((el) => {
    candidates.push((el.innerText || el.textContent || '').trim());
  });
  const supportHeaderOpen = Array.from(document.querySelectorAll('span, div')).some((el) => {
    const text = (el.textContent || '').trim();
    if (!normalize(text).includes('suporte sig prodata')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.left > Math.min(420, window.innerWidth * 0.33)
      && rect.top < 220;
  });
  if (supportHeaderOpen) return 'Suporte SIG Prodata';
  if (candidates.some((text) => normalize(text).includes('suporte sig prodata'))) {
    return 'Suporte SIG Prodata';
  }
  return candidates.find((text) => text && text.length > 2) || '';
})()
"""


SET_SUPPORT_GROUP_JS = r"""
((enabled) => {
  const panel = document.getElementById('prodata-assist-inline');
  if (!panel) return false;
  panel.classList.toggle('pa-support-group', Boolean(enabled));
  return true;
})(%s)
"""


def _parse_time_parts(value: str) -> tuple[int, int] | None:
    digits = re.sub(r"\D", "", value or "")[:4]
    if len(digits) < 2:
        return None
    try:
        hour = int(digits[:2])
        minute = int(digits[2:4]) if len(digits) >= 4 else 0
    except ValueError:
        return None
    return hour, minute


def _greeting_from_time(value: str) -> str:
    parts = _parse_time_parts(value)
    current_hour = datetime.now().hour if parts is None else parts[0]
    if current_hour < 12:
        return "Bom dia"
    if current_hour < 18:
        return "Boa Tarde"
    return "Boa Noite"


def _format_time_label(value: str) -> str:
    parts = _parse_time_parts(value)
    if parts is None:
        return ""
    hour, minute = parts
    if minute == 0:
        return f"{hour} h"
    return f"{hour:02d}:{minute:02d}h"


def _format_version_label(value: str) -> str:
    version = (value or "").strip()
    if not version:
        return "SIG Versão Oficial (Nº: 0.0)"
    if re.match(r"^sig\s+vers[aã]o\s+oficial", version, flags=re.I):
        return version
    if re.fullmatch(r"\d+(?:[.,]\d+)?", version):
        normalized = version.replace(",", ".")
        if "." not in normalized:
            normalized = f"{normalized}.0"
        return f"SIG Versão Oficial (Nº: {normalized})"
    return f"Versão {version}"


def update_notice(date="28/05/2026", time_value="15:00", version="Sig Integrações Rest 4.0.113"):
    greeting = _greeting_from_time(time_value)
    time_label = _format_time_label(time_value) or time_value
    version_label = _format_version_label(version)
    return (
        f"*{greeting}, Informamos que a atualização do sistema Prodata será realizada às {time_label} do dia {date}.*\n\n"
        "Durante esse período, o sistema ficará indisponível por aproximadamente 20 a 40 minutos.\n\n"
        f"*{version_label}*\n\n"
        "Agradecemos a compreensão de todos."
    )


POLL_STATE_JS = r"""
(() => {
  const root = document.querySelector('#main');
  const panel = document.getElementById('prodata-assist-inline');
  const opener = document.getElementById('prodata-assist-inline-opener');
  const result = {rows: [], chatTitle: '', ocrState: null, supportGroup: false, widgetMounted: Boolean(panel && opener)};

  // --- MESSAGE ROWS (inline from MESSAGE_ROWS_JS) ---
  if (root) {
    const ownNames = ['prodata gurupi', 'você', 'voce'];
    const messageNodes = Array.from(root.querySelectorAll('[data-pre-plain-text]'));
    if (messageNodes.length) {
      const rows = [];
      for (const el of messageNodes.slice(-24)) {
        const pre = el.getAttribute('data-pre-plain-text') || '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.quoted-mention, [aria-label="Mensagem citada"], [data-testid="quoted-message"]').forEach((node) => node.remove());
        const hasMedia = Boolean(
          clone.querySelector('img, canvas, video, [data-testid*="media"], [data-testid*="image"], [data-icon="image-refreshed"]')
        );
        let text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
        text = text.replace(/^Você\s+/i, '').trim();
        text = text.replace(/\d{1,2}:\d{2}\s*$/, '').trim();
        if ((!text || text.length < 2) && !hasMedia) continue;
        if (text.includes('criptografia de ponta a ponta')) continue;
        if (/^(figurinha|foto|vídeo|video|áudio|audio)$/i.test(text)) {
          text = hasMedia ? '[imagem anexada]' : '';
        }
        if (/^(wds-|ic-|default-|lock-outline|plus-|mic-|forward-)/i.test(text)) continue;
        const senderMatch = pre.match(/\]\s*(.*?):\s*$/);
        const sender = senderMatch ? senderMatch[1].trim() : '';
        const mine = ownNames.some((name) => sender.toLowerCase().includes(name));
        rows.push({mine, text: text || '[imagem anexada]', sender, hasMedia});
      }
      result.rows = rows.slice(-18);
    }
  }

  // --- CHAT TITLE ---
  const normalize = (text) => (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (root) {
    const headers = [root.querySelector('header') || root];
    const candidates = [];
    headers.filter(Boolean).forEach((header) => {
      candidates.push((header.innerText || header.textContent || '').trim());
      header.querySelectorAll('[title], [aria-label], span, div').forEach((el) => {
        candidates.push((el.getAttribute('title') || '').trim());
        candidates.push((el.getAttribute('aria-label') || '').trim());
        candidates.push((el.textContent || '').trim());
      });
    });
    document.querySelectorAll('[aria-selected="true"], [aria-current="true"]').forEach((el) => {
      candidates.push((el.innerText || el.textContent || '').trim());
    });
    const supportHeaderOpen = Array.from(document.querySelectorAll('span, div')).some((el) => {
      const text = (el.textContent || '').trim();
      if (!normalize(text).includes('suporte sig prodata')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left > Math.min(420, window.innerWidth * 0.33) && rect.top < 220;
    });
    result.chatTitle = supportHeaderOpen ? 'Suporte SIG Prodata' : (candidates.find((text) => text && text.length > 2) || '');
  }

  // --- OCR STATE ---
  if (window.__prodataAssistGetOcrState) {
    try { result.ocrState = window.__prodataAssistGetOcrState(); } catch(e) {}
  }

  result.supportGroup = normalize(result.chatTitle).includes('suporte sig prodata');
  return JSON.stringify(result);
})()
"""


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
    return "\n".join(lines[-24:])


def contextual_fallback(context):
    return "O sênior não deixou eu responder essa."


def learn_pairs(rows, learned):
    previous = ""
    for row in rows:
        text = (row.get("text") or "").strip()
        mine = bool(row.get("mine"))
        if not mine:
            previous = text
            continue
        if not previous or not (is_valid_pair(previous, text) or is_learning_candidate(previous, text)):
            previous = text
            continue
        key = f"{previous} -> {text}"
        if key in learned:
            previous = text
            continue
        learned.add(key)
        save_learning(previous, "", text, "Aprendido automaticamente da conversa no ZapZap.")
        previous = text


def build_context_from_rows(rows):
    lines = []
    for row in rows:
        label = "EU" if row.get("mine") else "CLIENTE"
        text = (row.get("text") or "").strip()
        if row.get("hasMedia") and "[imagem anexada]" not in text.lower():
            text = f"{text} [imagem anexada]".strip()
        if text:
            lines.append(f"{label}: {text}")
    return "\n".join(lines)


def rows_last_message_is_mine(rows):
    return bool(rows and rows[-1].get("mine"))


def has_recent_media(rows, window=6):
    return any(bool(row.get("hasMedia")) for row in (rows or [])[-window:])


def generate_inline_suggestion(context, image_base64=""):
    context = clean_context(context)
    try:
        details = generate_prodata_response_details(
            "",
            "",
            "profissional",
            conversation_context=context,
            image_base64=image_base64,
            fast=True,
        )
        if details:
            return details
    except Exception:
        pass
    fallback = contextual_fallback(context)
    return {
        "final_text": fallback,
        "final_source": "fallback_minimo",
        "elapsed_ms": 0,
        "candidates": [{"source": "fallback_minimo", "label": "Fallback", "text": fallback, "elapsed_ms": 0, "judge_score": -10, "winner": True}],
        "errors": [],
    }


def generate_inline_preview(context):
    context = clean_context(context)
    try:
        return generate_prodata_preview_details(
            "",
            "",
            "profissional",
            conversation_context=context,
        )
    except RuntimeError:
        return {"final_text": "", "final_source": "", "elapsed_ms": 0, "candidates": [], "errors": []}


def devtools_ready(timeout=2.0):
    try:
        with urllib.request.urlopen(ZAPZAP_DEVTOOLS_JSON_URL, timeout=timeout) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def connect_cdp_session():
    last_error = None
    for attempt in range(3):
        if not devtools_ready(timeout=1.5):
            last_error = RuntimeError("Porta 9222 indisponivel.")
            time.sleep(1.0)
            continue
        try:
            cdp = CdpClient(port=ZAPZAP_DEVTOOLS_PORT)
            target = cdp.connect_whatsapp()
            cdp.evaluate(PANEL_JS, timeout=6)
            return cdp, target
        except Exception as exc:
            last_error = exc
            print(f"[prodata-inline] falha ao conectar no CDP (tentativa {attempt + 1}/3): {exc}", flush=True)
            time.sleep(1.0)
    if last_error:
        raise last_error
    raise RuntimeError("Falha ao conectar no CDP do ZapZap.")


def main():
    threading.Thread(target=warm_local_support_models, daemon=True).start()
    cdp, target = connect_cdp_session()
    print(
        f"[prodata-inline] connected target title={target.get('title')!r} url={target.get('url')!r}",
        flush=True,
    )
    last_context = ""
    last_support_group = None
    last_ocr_request = 0
    learned = set()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    pending_generation = None
    pending_generation_key = ""

    while True:
        try:
            # UNIFIED CDP CALL: rows + chat_title + ocr_state in ONE eval (was 4 sequential calls)
            raw_state = cdp.evaluate(POLL_STATE_JS, timeout=5)
            try:
                state = json.loads(raw_state) if isinstance(raw_state, str) and raw_state else {}
            except Exception:
                state = {}
            if not isinstance(state, dict):
                state = {}
            if not state.get("widgetMounted"):
                cdp.evaluate(PANEL_JS, timeout=5)
                time.sleep(0.15)
                continue

            rows = state.get("rows") or []
            chat_title = (state.get("chatTitle") or "").strip()
            support_group = bool(state.get("supportGroup"))
            ocr_state = state.get("ocrState") or {}
            if not isinstance(ocr_state, dict):
                ocr_state = {}

            if support_group != last_support_group:
                last_support_group = support_group
                cdp.evaluate(SET_SUPPORT_GROUP_JS % json.dumps(support_group), timeout=3)

            viewer_open = bool(ocr_state.get("open"))
            current_ocr_request = int(ocr_state.get("request") or 0)
            if current_ocr_request and current_ocr_request != last_ocr_request:
                last_ocr_request = current_ocr_request
                try:
                    ocr_text = capture_ocr_text(cdp, ocr_state)
                    ocr_text = (ocr_text or "").strip()
                    if ocr_text:
                        write_clipboard_text(ocr_text)
                        payload = {
                            "status": "OCR concluido",
                            "suggestion": ocr_text,
                            "placeholder": "",
                            "support_group": False,
                            "candidates": [],
                        }
                        cdp.evaluate(UPDATE_PANEL_JS % json.dumps(payload, ensure_ascii=False), timeout=4)
                    else:
                        cdp.evaluate(
                            UPDATE_PANEL_JS % json.dumps(
                                {
                                    "status": "OCR concluido, mas nenhum texto foi encontrado.",
                                    "suggestion": "",
                                    "placeholder": "",
                                    "support_group": False,
                                    "candidates": [],
                                },
                                ensure_ascii=False,
                            ),
                            timeout=4,
                        )
                except Exception as exc:
                    cdp.evaluate(
                        UPDATE_PANEL_JS % json.dumps(
                            {
                                "status": f"OCR falhou: {exc}",
                                "suggestion": "",
                                "placeholder": "",
                                "support_group": False,
                                "candidates": [],
                            },
                            ensure_ascii=False,
                        ),
                        timeout=4,
                    )

            if viewer_open:
                continue

            context = build_context_from_rows(rows)
            context_key = f"{chat_title}\n{context}"
            if support_group and context_key != last_context:
                last_context = context_key
                cdp.evaluate(SHOW_LOADING_JS, timeout=3)
                payload = {
                    "status": "",
                    "suggestion": update_notice(),
                    "placeholder": "",
                    "support_group": True,
                    "candidates": [],
                }
                cdp.evaluate(UPDATE_PANEL_JS % json.dumps(payload, ensure_ascii=False), timeout=4)
                cdp.evaluate(COMPLETE_LOADING_JS, timeout=3)
            elif context and context_key != last_context:
                last_context = context_key
                learn_pairs(rows, learned)
                cdp.evaluate(SHOW_LOADING_JS, timeout=3)
                if rows_last_message_is_mine(rows):
                    payload = {
                        "status": "aguardando cliente",
                        "suggestion": "",
                        "placeholder": "Última mensagem foi sua. Aguardando resposta do cliente.",
                        "support_group": False,
                        "candidates": [],
                    }
                    pending_generation = None
                    pending_generation_key = ""
                else:
                    preview = generate_inline_preview(context)
                    preview_text = str((preview or {}).get("final_text") or "").strip()
                    preview_source = str((preview or {}).get("final_source") or "").strip()
                    preview_elapsed_ms = int((preview or {}).get("elapsed_ms") or 0) if isinstance(preview, dict) else 0
                    preview_candidates = (preview or {}).get("candidates") if isinstance(preview, dict) else []
                    payload = {
                        "status": "quebrando a cabeça...",
                        "suggestion": preview_text,
                        "placeholder": "",
                        "support_group": False,
                        "candidates": preview_candidates or [],
                        "source": preview_source,
                        "elapsed_ms": preview_elapsed_ms,
                    }
                    if pending_generation_key != context_key or pending_generation is None:
                        image_base64 = ""
                        if has_recent_media(rows):
                            try:
                                image_base64 = capture_chat_context_image(cdp)
                            except Exception:
                                image_base64 = ""
                        print(f"[prodata-inline] SUBMIT context_key={context_key[:40]!r}", flush=True)
                        pending_generation = executor.submit(generate_inline_suggestion, context, image_base64)
                        pending_generation_key = context_key
                    else:
                        print(f"[prodata-inline] SKIP already pending key={pending_generation_key[:40]!r} done={pending_generation.done() if pending_generation else 'None'}", flush=True)
                cdp.evaluate(UPDATE_PANEL_JS % json.dumps(payload, ensure_ascii=False), timeout=4)
                cdp.evaluate(COMPLETE_LOADING_JS, timeout=3)
            elif pending_generation and pending_generation.done() and pending_generation_key == context_key:
                try:
                    details = pending_generation.result() or {}
                except Exception as exc:
                    print(f"[prodata-inline] RESULT ERROR: {exc}", flush=True)
                    details = {}
                pending_generation = None
                pending_generation_key = ""
                suggestion = str(details.get("final_text") or "").strip()
                candidates = details.get("candidates") if isinstance(details, dict) else []
                source = str(details.get("final_source") or "")
                elapsed_ms = int(details.get("elapsed_ms") or 0) if isinstance(details, dict) else 0
                print(f"[prodata-inline] RESULT source={source} elapsed={elapsed_ms}ms candidates={len(candidates)} suggestion={suggestion[:60]!r}", flush=True)
                for c in candidates:
                    print(f"[prodata-inline]   candidate: source={c.get('source')} winner={c.get('winner')} score={c.get('judge_score')}", flush=True)
                if not suggestion:
                    suggestion = contextual_fallback(context)
                    candidates = [{"source": "fallback_minimo", "label": "Fallback", "text": suggestion, "elapsed_ms": elapsed_ms, "judge_score": -10, "winner": True}]
                cdp.evaluate(
                    UPDATE_PANEL_JS % json.dumps(
                        {
                            "status": "",
                            "suggestion": suggestion,
                            "placeholder": "",
                            "support_group": False,
                            "candidates": candidates,
                            "source": source,
                            "elapsed_ms": elapsed_ms,
                        },
                        ensure_ascii=False,
                    ),
                    timeout=4,
                )
            time.sleep(0.25)
        except KeyboardInterrupt:
            raise
        except Exception:
            import traceback

            traceback.print_exc()
            time.sleep(1.5)
            try:
                cdp, target = connect_cdp_session()
                print(
                    f"[prodata-inline] reconnected target title={target.get('title')!r} url={target.get('url')!r}",
                    flush=True,
                )
            except Exception as exc:
                print(f"[prodata-inline] reconexao falhou: {exc}", flush=True)
                time.sleep(2.0)


if __name__ == "__main__":
    main()
