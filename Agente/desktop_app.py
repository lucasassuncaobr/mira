#!/usr/bin/env python3
import re
import shutil
import subprocess
import tempfile
import time
import threading
from pathlib import Path

import gi
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

from server import (
    build_context,
    build_prodata_prompt,
    build_compact_context,
    contextual_fallback,
    known_prodata_reply,
    mimo_generate,
    resolve_model,
    save_learning,
)

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
    "comprovacao": "comprovação",
    "copia": "cópia",
    "descricao": "descrição",
    "disponivel": "disponível",
    "documentacao": "documentação",
    "facil": "fácil",
    "funcao": "função",
    "geracao": "geração",
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
    "selecao": "seleção",
    "servicos": "serviços",
    "situacao": "situação",
    "solucao": "solução",
    "tambem": "também",
    "tecnico": "técnico",
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
        repl = _OCR_ACCENT_MAP.get(token.lower())
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


def get_buffer_text(text_view):
    buffer = text_view.get_buffer()
    start = buffer.get_start_iter()
    end = buffer.get_end_iter()
    return buffer.get_text(start, end, True).strip()


def set_buffer_text(text_view, text):
    text_view.get_buffer().set_text(text)


def run_command(args, input_text=None, timeout=2):
    try:
        result = subprocess.run(
            args,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip()


def read_clipboard_text(primary=False):
    commands = (
        (["wl-paste", "--primary", "--no-newline"], primary),
        (["wl-paste", "--no-newline"], not primary),
        (["xclip", "-selection", "primary", "-o"], primary),
        (["xclip", "-selection", "clipboard", "-o"], not primary),
    )
    for args, enabled in commands:
        if not enabled:
            continue
        text = run_command(args, timeout=1)
        if text:
            return text
    return ""


def write_clipboard_text(text):
    cached = getattr(write_clipboard_text, "_command", None)
    if not cached:
        for args in (["wl-copy"], ["xclip", "-selection", "clipboard"]):
            if shutil.which(args[0]):
                cached = args
                write_clipboard_text._command = args
                break
    if not cached:
        return False
    try:
        result = subprocess.run(
            cached,
            input=text,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=0.35,
            check=False,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        if hasattr(write_clipboard_text, "_command"):
            delattr(write_clipboard_text, "_command")
        return False


def write_clipboard_text_async(text):
    value = text or ""
    if not value:
        return
    threading.Thread(target=write_clipboard_text, args=(value,), daemon=True).start()


def _resize_for_ocr(image, target_edge=1800, max_edge=2600):
    base = max(image.size)
    if base and base < target_edge:
        scale = min(2.4, target_edge / float(base))
        if scale > 1.0:
            return image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    if base and base > max_edge:
        scale = max_edge / float(base)
        return image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    return image


def _prepare_ocr_variants(image):
    gray = _resize_for_ocr(image.convert("L"))
    base = ImageOps.autocontrast(gray)
    variants = []

    sharp = ImageEnhance.Sharpness(ImageEnhance.Contrast(base).enhance(1.35)).enhance(1.6)
    variants.append(("sharp", sharp.filter(ImageFilter.MedianFilter(size=3))))

    # Keep OCR conservative for photos of screens. High threshold/inverted variants
    # created repeated UI words on WhatsApp screenshots.
    contrast = ImageEnhance.Contrast(base).enhance(1.55)
    variants.append(("contrast", contrast))
    return variants


def _prepare_ocr_image(image):
    return _prepare_ocr_variants(image)[0][1]


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
        if "y" not in item_data:
            item_data["x"] = 0
            item_data["y"] = len(groups) * 16
            item_data["h"] = 16
            item_data["w"] = len(text) * 8
        placed = False
        for group in groups:
            tolerance = max(12, group["h"] * 0.75)
            if abs(item_data["y"] - group["y"]) <= tolerance:
                group["items"].append(item_data)
                count = len(group["items"])
                group["y"] = ((group["y"] * (count - 1)) + item_data["y"]) / count
                group["h"] = max(group["h"], item_data["h"])
                placed = True
                break
        if not placed:
            groups.append({"y": item_data["y"], "h": item_data["h"], "items": [item_data]})
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
        broken_heading = (
            len(buffer) <= 28
            and len(line) <= 22
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


def _strip_repeated_ocr_runs(line):
    value = line or ""
    # RapidOCR can read the WhatsApp composer as EntendiEntendiEntendi...
    # when the selected area includes the bottom bar. Remove those runs.
    pattern = re.compile(r"([A-Za-zÀ-ÿ]{4,18})(?:\1){2,}", re.IGNORECASE)
    previous = None
    while previous != value:
        previous = value
        value = pattern.sub(r"\1", value)
    return value


def _cleanup_ocr_text(text):
    raw_lines = [line.strip() for line in (text or "").replace("\r", "\n").split("\n")]
    lines = [line for line in raw_lines if line]
    lines = _merge_fragmented_lines(lines)
    cleaned = []
    seen = set()
    noise_patterns = [
        r"^(\d{1,2}:\d{2}|hoje|ontem)$",
        r"^(baixar|download|encaminhar|responder|copiar|reagir)$",
        r"^(wds-|ic-|tail-|forward-|default-|lock-outline|plus-|mic-)",
        r"criptografia de ponta a ponta",
    ]
    for line in lines:
        line = _normalize_ocr_text(line)
        line = _strip_repeated_ocr_runs(line)
        line = re.sub(r"\s+([,.;:!?])", r"\1", line)
        line = re.sub(r"(?<=\w)-\s+(?=\w)", "-", line)
        line = re.sub(r"^[|•·\-\s]+", "", line).strip()
        line = _restore_ocr_accents(line)
        low = line.lower()
        if any(re.search(pattern, low) for pattern in noise_patterns):
            continue
        key = _normalize_ocr_text(low)
        if line and key not in seen:
            seen.add(key)
            cleaned.append(line)
    return "\n".join(cleaned).strip()


def _looks_repeated_ocr_noise(text):
    compact = re.sub(r"\s+", "", (text or "").strip().lower())
    if len(compact) < 18:
        return False
    for size in range(4, min(18, len(compact) // 3) + 1):
        chunk = compact[:size]
        if len(set(chunk)) < 3:
            continue
        repeats = 0
        pos = 0
        while compact.startswith(chunk, pos):
            repeats += 1
            pos += size
        if repeats >= 3 and pos >= len(compact) * 0.7:
            return True
    words = re.findall(r"[A-Za-zÀ-ÿ]{3,}", text or "")
    if len(words) >= 6:
        most_common = max(words.count(word) for word in set(words))
        if most_common >= max(5, int(len(words) * 0.65)):
            return True
    return False


def _ocr_text_score(text):
    cleaned = _cleanup_ocr_text(text)
    if not cleaned or _looks_repeated_ocr_noise(cleaned):
        return 0
    words = re.findall(r"[A-Za-zÀ-ÿ0-9]{2,}", cleaned)
    if not words:
        return 0
    alpha = sum(1 for word in words if re.search(r"[A-Za-zÀ-ÿ]", word))
    useful_terms = sum(
        1
        for term in (
            "erro",
            "prodata",
            "sicap",
            "usuario",
            "usuário",
            "senha",
            "empenho",
            "requisição",
            "requisicao",
            "chamado",
            "processo",
        )
        if term in cleaned.lower()
    )
    return len(words) + alpha + (useful_terms * 8) - min(20, cleaned.count("�") * 5)


def _best_ocr_text(candidates):
    best = ""
    best_score = 0
    for text in candidates:
        cleaned = _cleanup_ocr_text(text)
        score = _ocr_text_score(cleaned)
        if score > best_score:
            best = cleaned
            best_score = score
    return best


def _write_ocr_variant(image, suffix=".png"):
    temp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    image.save(temp.name)
    temp.close()
    return temp.name


def perform_ocr(image_path):
    temp_path = None
    temp_paths = []
    variant_paths = []
    try:
        with Image.open(image_path) as image:
            for name, prepared in _prepare_ocr_variants(image):
                path = _write_ocr_variant(prepared)
                temp_paths.append(path)
                variant_paths.append((name, path))
        if variant_paths:
            temp_path = variant_paths[0][1]
            image_path = temp_path
    except Exception:
        pass

    candidates = []
    try:
        from rapidocr_onnxruntime import RapidOCR

        if not hasattr(perform_ocr, "_rapidocr"):
            perform_ocr._rapidocr = RapidOCR()
        for _name, path in (variant_paths[:3] or [("original", image_path)]):
            result = perform_ocr._rapidocr(path)
            if isinstance(result, tuple):
                result = result[0]
            lines = _group_ocr_lines(result)
            text = _cleanup_ocr_text("\n".join(lines))
            if text:
                candidates.append(text)
        text = _best_ocr_text(candidates)
        if text:
            return text
    except Exception:
        pass

    try:
        from pytesseract import image_to_string

        for _name, path in (variant_paths or [("original", image_path)]):
            with Image.open(path) as image:
                for psm in ("6", "11"):
                    text = image_to_string(image, lang="por+eng", config=f"--oem 3 --psm {psm}").strip()
                    if text:
                        candidates.append(text)
        text = _best_ocr_text(candidates)
        if text:
            return text
    except Exception:
        pass

    try:
        for _name, path in (variant_paths[:2] or [("original", image_path)]):
            for psm in ("6", "11"):
                result = subprocess.run(
                    ["tesseract", path, "stdout", "-l", "por+eng", "--oem", "3", "--psm", psm],
                    capture_output=True,
                    text=True,
                    timeout=35,
                    check=False,
                )
                if result.stdout:
                    candidates.append(result.stdout)
        text = _best_ocr_text(candidates)
        if text:
            return text
    except Exception:
        pass
    finally:
        for path in temp_paths:
            Path(path).unlink(missing_ok=True)

    raise RuntimeError(
        "Nenhum motor OCR disponivel. Instale rapidocr-onnxruntime ou tesseract."
    )


class OcrWindow(Gtk.Window):
    def __init__(self, app, on_text):
        super().__init__(application=app, title="OCR de imagem")
        self.set_default_size(980, 720)
        self.on_text = on_text
        self.pixbuf = None
        self.image_path = None
        self.primary_rect = None
        self.drag_start = None
        self.drag_current = None
        self.ocr_running = False

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.set_margin_top(12)
        root.set_margin_bottom(12)
        root.set_margin_start(12)
        root.set_margin_end(12)
        self.set_child(root)

        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        root.append(top)

        open_button = Gtk.Button(label="Abrir imagem")
        open_button.connect("clicked", self.on_open_image)
        top.append(open_button)

        ocr_button = Gtk.Button(label="OCR da seleção")
        ocr_button.add_css_class("suggested-action")
        ocr_button.connect("clicked", self.on_run_ocr)
        top.append(ocr_button)

        use_button = Gtk.Button(label="Usar resultado")
        use_button.connect("clicked", self.on_use_result)
        top.append(use_button)

        clear_button = Gtk.Button(label="Limpar")
        clear_button.connect("clicked", self.on_clear)
        top.append(clear_button)

        self.status = Gtk.Label(label="Abra uma imagem e arraste para selecionar a area.")
        self.status.set_xalign(0)
        root.append(self.status)

        overlay = Gtk.Overlay()
        overlay.set_hexpand(True)
        overlay.set_vexpand(True)
        root.append(overlay)

        self.picture = Gtk.Picture()
        self.picture.set_can_shrink(True)
        self.picture.set_content_fit(Gtk.ContentFit.CONTAIN)
        overlay.set_child(self.picture)

        self.canvas = Gtk.DrawingArea()
        self.canvas.set_hexpand(True)
        self.canvas.set_vexpand(True)
        self.canvas.set_draw_func(self.on_draw)
        gesture = Gtk.GestureDrag()
        gesture.connect("drag-begin", self.on_drag_begin)
        gesture.connect("drag-update", self.on_drag_update)
        gesture.connect("drag-end", self.on_drag_end)
        self.canvas.add_controller(gesture)
        overlay.add_overlay(self.canvas)

        self.result_view = Gtk.TextView()
        self.result_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.result_view.set_editable(True)
        self.result_view.set_vexpand(False)
        result_scroll = Gtk.ScrolledWindow()
        result_scroll.set_min_content_height(140)
        result_scroll.set_child(self.result_view)
        root.append(result_scroll)

    def set_status(self, text):
        self.status.set_text(text or "")

    def on_open_image(self, _button):
        chooser = Gtk.FileChooserNative.new(
            "Selecionar imagem",
            self,
            Gtk.FileChooserAction.OPEN,
            "Abrir",
            "Cancelar",
        )
        filter_images = Gtk.FileFilter()
        filter_images.set_name("Imagens")
        for pattern in ["*.png", "*.jpg", "*.jpeg", "*.webp", "*.bmp", "*.tif", "*.tiff"]:
            filter_images.add_pattern(pattern)
        chooser.add_filter(filter_images)
        chooser.connect("response", self.on_file_response)
        chooser.show()

    def on_file_response(self, chooser, response_id):
        if response_id != Gtk.ResponseType.ACCEPT:
            chooser.destroy()
            return
        file_obj = chooser.get_file()
        chooser.destroy()
        if not file_obj:
            return
        path = file_obj.get_path()
        if not path:
            self.set_status("Nao consegui ler o arquivo selecionado.")
            return
        self.load_image(path)

    def load_image(self, path):
        try:
            self.pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
        except Exception as exc:
            self.set_status(f"Falha ao abrir imagem: {exc}")
            return
        self.image_path = path
        self.primary_rect = None
        self.drag_start = None
        self.drag_current = None
        self.picture.set_pixbuf(self.pixbuf)
        self.canvas.queue_draw()
        self.set_status("Imagem carregada. Arraste para selecionar a area do texto.")

    def _fit_rect(self, width, height):
        if not self.pixbuf:
            return None
        img_w = max(1, self.pixbuf.get_width())
        img_h = max(1, self.pixbuf.get_height())
        scale = min(width / img_w, height / img_h)
        draw_w = img_w * scale
        draw_h = img_h * scale
        left = (width - draw_w) / 2
        top = (height - draw_h) / 2
        return left, top, draw_w, draw_h, scale

    def on_draw(self, _area, cr, width, height):
        if not self.pixbuf:
            cr.set_source_rgba(0.05, 0.07, 0.06, 0.72)
            cr.paint()
            cr.set_source_rgba(0.9, 0.95, 0.92, 0.8)
            cr.select_font_face("Sans")
            cr.set_font_size(18)
            cr.move_to(24, 42)
            cr.show_text("Abra uma imagem para selecionar uma area e extrair o texto.")
            return
        rect = self._fit_rect(width, height)
        if not rect:
            return
        left, top, draw_w, draw_h, _scale = rect
        if self.primary_rect:
            x1, y1, x2, y2 = self.primary_rect
            sel_left = min(x1, x2)
            sel_top = min(y1, y2)
            sel_w = abs(x2 - x1)
            sel_h = abs(y2 - y1)
            cr.set_source_rgba(0.14, 0.89, 0.51, 0.22)
            cr.rectangle(sel_left, sel_top, sel_w, sel_h)
            cr.fill()
            cr.set_source_rgba(0.14, 0.89, 0.51, 0.95)
            cr.set_line_width(2)
            cr.rectangle(sel_left + 1, sel_top + 1, max(0, sel_w - 2), max(0, sel_h - 2))
            cr.stroke()

    def on_drag_begin(self, _gesture, start_x, start_y):
        if not self.pixbuf:
            return
        self.drag_start = (start_x, start_y)
        self.drag_current = (start_x, start_y)
        self.primary_rect = (start_x, start_y, start_x, start_y)
        self.canvas.queue_draw()

    def on_drag_update(self, _gesture, offset_x, offset_y):
        if not self.drag_start:
            return
        start_x, start_y = self.drag_start
        self.drag_current = (start_x + offset_x, start_y + offset_y)
        self.primary_rect = (start_x, start_y, *self.drag_current)
        self.canvas.queue_draw()

    def on_drag_end(self, _gesture, offset_x, offset_y):
        if not self.drag_start:
            return
        start_x, start_y = self.drag_start
        self.drag_current = (start_x + offset_x, start_y + offset_y)
        self.primary_rect = (start_x, start_y, *self.drag_current)
        self.canvas.queue_draw()
        self.start_ocr()

    def on_run_ocr(self, _button):
        self.start_ocr()

    def on_clear(self, _button):
        self.image_path = None
        self.pixbuf = None
        self.primary_rect = None
        self.drag_start = None
        self.drag_current = None
        self.set_status("Imagem limpa.")
        self.picture.set_pixbuf(None)
        self.canvas.queue_draw()
        set_buffer_text(self.result_view, "")

    def on_use_result(self, _button):
        text = get_buffer_text(self.result_view)
        if not text:
            self.set_status("Nao ha texto OCR para usar.")
            return
        self.on_text(text)
        self.set_status("Texto OCR enviado para a mensagem do cliente.")

    def _image_rect_to_crop(self):
        if not self.pixbuf or not self.primary_rect:
            return None
        width = self.canvas.get_width()
        height = self.canvas.get_height()
        if width <= 0 or height <= 0:
            return None
        fit = self._fit_rect(width, height)
        if not fit:
            return None
        left, top, draw_w, draw_h, scale = fit
        img_w = self.pixbuf.get_width()
        img_h = self.pixbuf.get_height()
        x1, y1, x2, y2 = self.primary_rect
        x1 = max(left, min(left + draw_w, x1))
        x2 = max(left, min(left + draw_w, x2))
        y1 = max(top, min(top + draw_h, y1))
        y2 = max(top, min(top + draw_h, y2))
        crop_left = int(max(0, min(img_w, (min(x1, x2) - left) / scale)))
        crop_top = int(max(0, min(img_h, (min(y1, y2) - top) / scale)))
        crop_right = int(max(0, min(img_w, (max(x1, x2) - left) / scale)))
        crop_bottom = int(max(0, min(img_h, (max(y1, y2) - top) / scale)))
        if crop_right - crop_left < 8 or crop_bottom - crop_top < 8:
            return None
        return crop_left, crop_top, crop_right, crop_bottom

    def start_ocr(self):
        if self.ocr_running:
            return
        if not self.image_path:
            self.set_status("Abra uma imagem antes de selecionar uma area.")
            return
        crop = self._image_rect_to_crop()
        if not crop:
            self.set_status("Selecione uma area valida na imagem.")
            return
        self.ocr_running = True
        self.set_status("Processando OCR...")
        thread = threading.Thread(target=self.ocr_worker, args=(crop,), daemon=True)
        thread.start()

    def ocr_worker(self, crop):
        temp_path = None
        try:
            with Image.open(self.image_path) as image:
                cropped = image.convert("RGB").crop(crop)
                with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                    temp_path = tmp.name
                    cropped.save(temp_path)
            text = perform_ocr(temp_path)
            GLib.idle_add(self.finish_ocr, text, "")
        except Exception as exc:
            GLib.idle_add(self.finish_ocr, "", str(exc))
        finally:
            if temp_path:
                Path(temp_path).unlink(missing_ok=True)

    def finish_ocr(self, text, error):
        self.ocr_running = False
        if error:
            self.set_status(error)
            return False
        text = (text or "").strip()
        set_buffer_text(self.result_view, text)
        if text:
            self.on_text(text)
            self.set_status("OCR concluido e texto enviado para a mensagem do cliente.")
        else:
            self.set_status("OCR concluido, mas nenhum texto foi encontrado.")
        return False


class ProdataWindow(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Agente Prodata")
        self.set_default_size(120, 120)
        self.last_clipboard = ""
        self.last_primary = ""
        self.generating = False
        self.primary_poll_busy = False
        self.chat_open = False
        self.loading_timers = []
        self.message_count = 0
        self.last_customer_message = ""
        self.last_draft = ""
        self.last_reply = ""
        self.chat_opening = False
        self.chat_closing = False
        self.loading_phase_2_timer = None
        self.loading_clear_timer = None
        self.monitor = Gtk.Switch()
        self.selection_monitor = Gtk.Switch()

        self.set_resizable(False)
        self.set_deletable(True)
        self.apply_chat_style()

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.set_child(root)

        self.overlay = Gtk.Overlay()
        root.append(self.overlay)

        self.agent_stack = Gtk.Overlay()
        self.overlay.set_child(self.agent_stack)

        self.chat_shell = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.chat_shell.add_css_class("chat-shell")
        self.agent_stack.set_child(self.chat_shell)

        self.topbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.topbar.add_css_class("chat-topbar")
        self.topbar.set_margin_top(12)
        self.topbar.set_margin_bottom(0)
        self.topbar.set_margin_start(12)
        self.topbar.set_margin_end(12)
        self.chat_shell.append(self.topbar)

        left_top = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        left_top.set_hexpand(True)
        self.topbar.append(left_top)

        title = Gtk.Label(label="Prodata Assist")
        title.add_css_class("chat-title")
        title.set_xalign(0)
        left_top.append(title)

        self.status = Gtk.Label(label="Pronto para responder")
        self.status.add_css_class("chat-status")
        self.status.set_xalign(0)
        left_top.append(self.status)

        self.mode = Gtk.DropDown.new_from_strings(
            ["profissional", "curta", "mais simpatica", "mais firme", "passo a passo"]
        )
        self.mode.set_selected(0)
        self.topbar.append(self.mode)

        close_button = Gtk.Button(label="←")
        close_button.add_css_class("chat-close")
        close_button.connect("clicked", lambda _button: self.toggle_chat(False))
        self.topbar.append(close_button)

        self.body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.body.add_css_class("chat-body")
        self.body.set_margin_top(12)
        self.body.set_margin_bottom(12)
        self.body.set_margin_start(12)
        self.body.set_margin_end(12)
        self.body.set_vexpand(True)
        self.chat_shell.append(self.body)

        self.messages_scroll = Gtk.ScrolledWindow()
        self.messages_scroll.set_hexpand(True)
        self.messages_scroll.set_vexpand(True)
        self.messages_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.messages_scroll.add_css_class("messages-scroll")
        self.body.append(self.messages_scroll)

        self.messages_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.messages_box.set_valign(Gtk.Align.START)
        self.messages_scroll.set_child(self.messages_box)
        self.messages_scroll.get_vadjustment().connect(
            "value-changed", lambda *_args: self.update_scroll_button()
        )

        self.typing_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.typing_row.add_css_class("typing-row")
        for _ in range(3):
            dot = Gtk.Label(label="•")
            dot.add_css_class("typing-dot")
            self.typing_row.append(dot)

        self.composer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.composer.add_css_class("composer")
        self.body.append(self.composer)

        self.client_label = Gtk.Label(label="Mensagem do cliente")
        self.client_label.add_css_class("composer-label")
        self.client_label.set_xalign(0)
        self.composer.append(self.client_label)

        self.client_text = self.text_panel("", min_height=74)
        self.composer.append(self.client_text["box"])

        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.composer.append(row)

        self.paste_client = Gtk.Button(label="Colar clipboard")
        self.paste_client.connect("clicked", lambda _b: self.paste_into(self.client_text["view"]))
        row.append(self.paste_client)

        generate = Gtk.Button(label="Enviar")
        generate.add_css_class("suggested-action")
        generate.connect("clicked", self.on_generate)
        row.append(generate)

        self.scroll_button = Gtk.Button(label="⌄")
        self.scroll_button.add_css_class("scroll-button")
        self.scroll_button.connect("clicked", lambda _b: self.scroll_to_bottom())
        self.scroll_button.set_visible(False)
        self.overlay.add_overlay(self.scroll_button)

        self.agent_ring = Gtk.Button()
        self.agent_ring.add_css_class("agent-ring")
        self.agent_ring.set_sensitive(False)
        self.agent_ring.set_visible(False)
        self.overlay.add_overlay(self.agent_ring)

        self.agent_button = Gtk.Button()
        self.agent_button.add_css_class("agent-button")
        self.agent_button.set_tooltip_text("Abrir agente")
        self.agent_button.connect("clicked", lambda _b: self.toggle_chat(not self.chat_open))
        self.overlay.add_overlay(self.agent_button)
        self.agent_button.set_child(self.agent_button_icon())
        self.scroll_button.set_halign(Gtk.Align.END)
        self.scroll_button.set_valign(Gtk.Align.END)
        self.scroll_button.set_margin_end(20)
        self.scroll_button.set_margin_bottom(20)
        self.agent_button.set_halign(Gtk.Align.END)
        self.agent_button.set_valign(Gtk.Align.END)
        self.agent_button.set_margin_end(20)
        self.agent_button.set_margin_bottom(82)
        self.agent_ring.set_halign(Gtk.Align.END)
        self.agent_ring.set_valign(Gtk.Align.END)
        self.agent_ring.set_margin_end(17)
        self.agent_ring.set_margin_bottom(79)

        self.learn_section = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.learn_section.add_css_class("learn-section")
        self.learn_section.set_margin_start(12)
        self.learn_section.set_margin_end(12)
        self.learn_section.set_margin_bottom(12)
        self.chat_shell.append(self.learn_section)

        self.learn_label = Gtk.Label(label="Detalhes opcionais")
        self.learn_label.add_css_class("composer-label")
        self.learn_label.set_xalign(0)
        self.learn_section.append(self.learn_label)

        self.draft_text = self.text_panel("Seu rascunho", min_height=74)
        self.learn_section.append(self.draft_text["box"])

        self.learn_text = self.text_panel("Aprendizado local", min_height=74)
        self.learn_section.append(self.learn_text["box"])

        action_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.learn_section.append(action_row)

        copy = Gtk.Button(label="Copiar resposta")
        copy.connect("clicked", self.on_copy)
        action_row.append(copy)

        clear = Gtk.Button(label="Limpar")
        clear.connect("clicked", self.on_clear)
        action_row.append(clear)

        save = Gtk.Button(label="Salvar aprendizado")
        save.connect("clicked", self.on_save_learning)
        action_row.append(save)

        GLib.timeout_add(1200, self.check_clipboard)
        GLib.timeout_add(350, self.check_primary_selection)
        self.chat_shell.set_visible(False)
        self.agent_button.set_visible(True)
        self.scroll_button.set_visible(False)
        self.ocr_window = None
        self.append_message("assistant", "Envie a mensagem do cliente para gerar uma resposta.", "system")

    def text_panel(self, label, min_height=150):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_hexpand(True)
        box.set_vexpand(True)
        box.append(Gtk.Label(label=label, xalign=0))

        scroller = Gtk.ScrolledWindow()
        scroller.set_min_content_height(min_height)
        scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        view = Gtk.TextView()
        view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        view.set_monospace(False)
        scroller.set_child(view)
        box.append(scroller)
        return {"box": box, "view": view}

    def paste_into(self, text_view):
        text = read_clipboard_text(primary=False)
        if not text:
            self.set_status("Nao consegui ler o clipboard.")
            return
        set_buffer_text(text_view, text)
        if text_view == self.client_text["view"]:
            self.last_clipboard = text
        self.set_status("Clipboard colado.")

    def apply_chat_style(self):
        css = b"""
        window {
          background: transparent;
        }
        .chat-shell {
          min-width: 420px;
          min-height: 740px;
          background:
            radial-gradient(circle at 20% 18%, rgba(255, 255, 255, 0.18), transparent 14%),
            linear-gradient(180deg, rgba(246, 241, 233, 0.98), rgba(236, 229, 221, 0.98));
          border: 1px solid rgba(18, 140, 126, 0.16);
          border-radius: 28px;
          opacity: 0;
          transform: translateY(20px) scale(0.95);
          transform-origin: bottom right;
          transition: opacity 300ms ease-out, transform 300ms ease-out;
        }
        .chat-shell.opening,
        .chat-shell.visible {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        .chat-shell.closing {
          opacity: 0;
          transform: translateY(10px) scale(0.98);
        }
        .chat-topbar {
          background: linear-gradient(135deg, rgba(18, 140, 126, 0.98), rgba(37, 211, 102, 0.96));
          padding: 14px 14px 12px;
          border-radius: 28px 28px 0 0;
        }
        .chat-title {
          color: #ffffff;
          font-weight: 800;
          font-size: 15px;
        }
        .chat-status {
          color: rgba(255, 255, 255, 0.88);
          font-size: 12px;
        }
        .chat-close {
          min-width: 36px;
          min-height: 36px;
          border-radius: 50%;
          border: 0;
          background: rgba(255, 255, 255, 0.16);
          color: #ffffff;
        }
        .chat-body {
          background:
            radial-gradient(circle at 20% 18%, rgba(255, 255, 255, 0.36), transparent 14%),
            linear-gradient(180deg, rgba(236, 229, 221, 0.96), rgba(228, 221, 212, 0.98));
          border-radius: 0 0 24px 24px;
        }
        .messages-scroll {
          background: transparent;
        }
        .message-row {
          padding: 0 2px;
        }
        .bubble {
          max-width: 300px;
          padding: 10px 12px;
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.96);
          color: #1f2c2a;
          border: 1px solid rgba(0, 0, 0, 0.04);
          opacity: 0;
          transform: translateY(8px);
          animation: messageSlideIn 300ms ease-out forwards;
        }
        .bubble.user {
          background: #dcf8c6;
          margin-left: auto;
        }
        .bubble.assistant {
          margin-right: auto;
        }
        .bubble.error {
          background: #fff0f0;
          color: #a23b3b;
        }
        .bubble.system {
          color: #57716c;
        }
        .typing-row {
          padding: 10px 12px;
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.96);
          width: fit-content;
          opacity: 0;
        }
        .typing-row.typing-visible {
          animation: fadeIn 300ms ease-out forwards;
        }
        .typing-dot {
          color: #7a8f8a;
          font-size: 18px;
          animation: paTyping 1.2s ease-in-out infinite;
        }
        .typing-dot:nth-child(2) {
          animation-delay: 120ms;
        }
        .typing-dot:nth-child(3) {
          animation-delay: 240ms;
        }
        .composer,
        .learn-section {
          background: rgba(255, 255, 255, 0.72);
          border-top: 1px solid rgba(21, 65, 55, 0.08);
          border-bottom-left-radius: 24px;
          border-bottom-right-radius: 24px;
        }
        .composer-label {
          color: #57716c;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }
        .agent-button,
        .scroll-button {
          min-width: 60px;
          min-height: 60px;
          border-radius: 50%;
          border: 0;
          background: linear-gradient(135deg, #128c7e, #25d366);
          color: #ffffff;
          box-shadow: 0 16px 38px rgba(18, 140, 126, 0.35);
        }
        .agent-button-label {
          color: #ffffff;
          font-size: 22px;
          font-weight: 800;
        }
        .agent-button.loading-active {
          box-shadow: 0 16px 38px rgba(18, 140, 126, 0.35);
        }
        .agent-button.pulse-complete {
          animation: subtlePulse 0.6s ease-in-out 2;
        }
        .agent-ring {
          min-width: 66px;
          min-height: 66px;
          border-radius: 50%;
          border: 3px solid transparent;
          border-top-color: #ffffff;
          border-right-color: #ffffff;
          background: transparent;
          opacity: 0;
          transform: rotate(0deg);
        }
        .agent-ring.loading-active {
          opacity: 1;
          animation: rotateLoading 1.5s linear infinite;
        }
        .agent-ring.pulse-complete {
          opacity: 1;
          animation: subtlePulse 0.6s ease-in-out 2;
        }
        .scroll-button {
          min-width: 52px;
          min-height: 52px;
        }
        .bubble.seq-0 { animation-delay: 0ms; }
        .bubble.seq-1 { animation-delay: 50ms; }
        .bubble.seq-2 { animation-delay: 100ms; }
        .bubble.seq-3 { animation-delay: 150ms; }
        .bubble.seq-4 { animation-delay: 200ms; }
        @keyframes paTyping {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.55; }
          40% { transform: translateY(-4px); opacity: 1; }
        }
        @keyframes rotateLoading {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes subtlePulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          }
          50% {
            transform: scale(1.08);
            box-shadow: 0 6px 20px rgba(37, 211, 102, 0.5);
          }
        }
        @keyframes messageSlideIn {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes fadeIn {
          to { opacity: 1; }
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

    def agent_button_icon(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)
        label = Gtk.Label(label="P")
        label.add_css_class("agent-button-label")
        box.append(label)
        return box

    def cancel_loading_timers(self):
        if self.loading_phase_2_timer is not None:
            GLib.source_remove(self.loading_phase_2_timer)
            self.loading_phase_2_timer = None
        if self.loading_clear_timer is not None:
            GLib.source_remove(self.loading_clear_timer)
            self.loading_clear_timer = None

    def start_ai_loading(self):
        self.cancel_loading_timers()
        self.agent_ring.set_visible(True)
        self.agent_ring.add_css_class("loading-active")
        self.agent_button.add_css_class("loading-active")

        def phase_two():
            self.agent_ring.remove_css_class("loading-active")
            self.agent_ring.add_css_class("pulse-complete")
            self.agent_button.remove_css_class("loading-active")
            self.agent_button.add_css_class("pulse-complete")
            self.loading_phase_2_timer = None
            return False

        def clear_pulse():
            self.agent_ring.remove_css_class("pulse-complete")
            self.agent_ring.set_visible(False)
            self.agent_button.remove_css_class("pulse-complete")
            self.loading_clear_timer = None
            return False

        self.loading_phase_2_timer = GLib.timeout_add(1800, phase_two)
        self.loading_clear_timer = GLib.timeout_add(2700, clear_pulse)

    def stop_ai_loading(self):
        self.agent_ring.remove_css_class("loading-active")
        self.agent_button.remove_css_class("loading-active")

    def reset_ai_loading(self):
        self.cancel_loading_timers()
        self.stop_ai_loading()
        self.agent_ring.remove_css_class("pulse-complete")
        self.agent_ring.set_visible(False)
        self.agent_button.remove_css_class("pulse-complete")

    def toggle_chat(self, open_state):
        opening = bool(open_state)
        if opening == self.chat_open and not self.chat_opening and not self.chat_closing and self.chat_shell.get_visible() == opening:
            return

        if opening:
            self.chat_closing = False
            self.chat_opening = True
            self.chat_open = True
            self.chat_shell.set_visible(True)
            self.chat_shell.add_css_class("visible")
            self.chat_shell.add_css_class("opening")
            self.chat_shell.remove_css_class("closing")
            self.agent_button.set_visible(False)
            self.agent_ring.set_visible(False)
            self.resize(420, 740)
            self.present()
            self.scroll_to_bottom("auto")
            self.set_status("Pronto para responder")
            self.client_text["view"].grab_focus()

            def finish_open():
                self.chat_shell.remove_css_class("opening")
                self.chat_opening = False
                return False

            GLib.timeout_add(300, finish_open)
            return

        self.chat_open = False
        self.chat_opening = False
        self.chat_closing = True
        self.chat_shell.add_css_class("closing")
        self.chat_shell.remove_css_class("opening")
        self.chat_shell.remove_css_class("visible")
        self.scroll_button.set_visible(False)
        self.agent_button.set_visible(True)

        def finish_close():
            self.chat_shell.remove_css_class("closing")
            self.chat_shell.set_visible(False)
            self.chat_closing = False
            self.resize(120, 120)
            return False

        GLib.timeout_add(300, finish_close)

    def append_message(self, role, text, variant=None):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        row.set_hexpand(True)
        row.set_halign(Gtk.Align.FILL)
        row.add_css_class("message-row")
        row.add_css_class(role)

        bubble = Gtk.Label(label=text or "")
        bubble.set_wrap(True)
        bubble.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        bubble.set_selectable(True)
        bubble.set_xalign(0)
        bubble.add_css_class("bubble")
        bubble.add_css_class(role)
        bubble.add_css_class(f"seq-{self.message_count % 5}")
        if variant:
            bubble.add_css_class(variant)

        if role == "user":
            bubble.set_halign(Gtk.Align.END)
            row.set_halign(Gtk.Align.END)
        else:
            bubble.set_halign(Gtk.Align.START)
            row.set_halign(Gtk.Align.START)

        row.append(bubble)
        self.messages_box.append(row)
        self.message_count += 1
        self.scroll_to_bottom()
        self.update_scroll_button()
        return bubble

    def show_typing(self):
        if self.typing_row.get_parent():
            return
        self.messages_box.append(self.typing_row)
        self.typing_row.add_css_class("typing-visible")
        self.scroll_to_bottom()
        self.update_scroll_button()

    def hide_typing(self):
        parent = self.typing_row.get_parent()
        if parent:
            parent.remove(self.typing_row)
        self.typing_row.remove_css_class("typing-visible")
        self.update_scroll_button()

    def scroll_to_bottom(self, behavior="smooth"):
        adjustment = self.messages_scroll.get_vadjustment()
        upper = adjustment.get_upper()
        page_size = adjustment.get_page_size()
        adjustment.set_value(max(0, upper - page_size))

    def update_scroll_button(self):
        adjustment = self.messages_scroll.get_vadjustment()
        has_overflow = adjustment.get_upper() - adjustment.get_page_size() > 24
        near_bottom = adjustment.get_value() + adjustment.get_page_size() >= adjustment.get_upper() - 24
        self.scroll_button.set_visible(bool(has_overflow and not near_bottom and self.chat_open))

    def set_status(self, text):
        self.status.set_text(text)

    def get_mode(self):
        selected = self.mode.get_selected_item()
        return selected.get_string() if selected else "profissional"

    def check_clipboard(self):
        if not self.monitor.get_active():
            return True
        text = read_clipboard_text(primary=False)
        if not text or text == self.last_clipboard:
            return True
        self.last_clipboard = text
        current = get_buffer_text(self.client_text["view"])
        response = self.last_reply
        if text != response and text != current and len(text) < 4000:
            set_buffer_text(self.client_text["view"], text)
            self.set_status("Mensagem capturada do clipboard.")
        return True

    def check_primary_selection(self):
        if not self.selection_monitor.get_active():
            return True
        if self.primary_poll_busy:
            return True
        display = Gdk.Display.get_default()
        if not display:
            return True
        clipboard = display.get_primary_clipboard()
        if not clipboard:
            return True
        self.primary_poll_busy = True
        clipboard.read_text_async(None, self.on_primary_text_ready, None)
        return True

    def on_primary_text_ready(self, clipboard, async_result, _data):
        try:
            text = clipboard.read_text_finish(async_result) or ""
        except Exception:
            text = ""
        self.primary_poll_busy = False
        text = text.strip()
        if not text or text == self.last_primary:
            return
        self.last_primary = text
        self.last_clipboard = text
        write_clipboard_text(text)
        current = get_buffer_text(self.client_text["view"])
        response = self.last_reply
        if text != current and text != response and len(text) < 4000:
            set_buffer_text(self.client_text["view"], text)
            self.set_status("Selecao capturada automaticamente.")

    def on_open_ocr(self, _button):
        if self.ocr_window and self.ocr_window.get_visible():
            self.ocr_window.present()
            return
        self.ocr_window = OcrWindow(self, self.on_ocr_text)
        self.ocr_window.connect("close-request", self.on_ocr_window_close_request)
        self.ocr_window.present()
        GLib.idle_add(self.ocr_window.on_open_image, None)

    def on_ocr_window_close_request(self, *_args):
        self.ocr_window = None
        return False

    def on_ocr_text(self, text):
        text = (text or "").strip()
        if not text:
            return
        set_buffer_text(self.client_text["view"], text)
        self.last_clipboard = text
        self.set_status("Texto OCR carregado em Mensagem do cliente.")

    def on_generate(self, _button):
        if self.generating:
            return
        cliente = get_buffer_text(self.client_text["view"])
        rascunho = get_buffer_text(self.draft_text["view"])
        modo = self.get_mode()
        if not cliente and not rascunho:
            self.set_status("Informe a mensagem ou seu rascunho.")
            return
        if cliente:
            self.last_customer_message = cliente
            self.append_message("user", cliente)
        elif rascunho:
            self.last_customer_message = rascunho
            self.append_message("user", rascunho)
        self.last_draft = rascunho
        self.generating = True
        self.start_ai_loading()
        self.show_typing()
        self.set_status("")
        thread = threading.Thread(
            target=self.generate_worker,
            args=(cliente, rascunho, modo),
            daemon=True,
        )
        thread.start()

    def generate_worker(self, cliente, rascunho, modo):
        quick_reply = known_prodata_reply(cliente, rascunho, modo)
        if quick_reply:
            GLib.idle_add(self.finish_generate, quick_reply, "")
            return
        model = resolve_model()
        prompt = build_prodata_prompt(cliente, rascunho, modo, build_compact_context(), fast=True)
        try:
            result = mimo_generate(prompt, model, timeout=12.0)
            GLib.idle_add(self.finish_generate, result, "")
        except RuntimeError as exc:
            fallback = contextual_fallback(cliente, rascunho, modo)
            GLib.idle_add(self.finish_generate, fallback, "")

    def finish_generate(self, result, error):
        self.generating = False
        self.hide_typing()
        if error:
            self.reset_ai_loading()
            self.set_status(error)
        else:
            self.last_reply = (result or "").strip()
            if self.last_reply:
                self.append_message("assistant", self.last_reply)
            self.set_status("Revise antes de enviar.")
        return False

    def on_copy(self, _button):
        text = self.last_reply
        if not text:
            self.set_status("Nao ha resposta para copiar.")
            return
        write_clipboard_text_async(text)
        self.last_clipboard = text
        self.set_status("Resposta copiada.")

    def on_clear(self, _button):
        for item in [self.client_text, self.draft_text, self.learn_text]:
            set_buffer_text(item["view"], "")
        self.last_clipboard = ""
        self.last_primary = ""
        self.last_customer_message = ""
        self.last_draft = ""
        self.last_reply = ""
        while (child := self.messages_box.get_first_child()) is not None:
            self.messages_box.remove(child)
        self.append_message("assistant", "Envie a mensagem do cliente para gerar uma resposta.", "system")
        self.set_status("")
        self.reset_ai_loading()

    def on_save_learning(self, _button):
        cliente = get_buffer_text(self.client_text["view"])
        rascunho = get_buffer_text(self.draft_text["view"])
        resposta = self.last_reply
        aprendizado = get_buffer_text(self.learn_text["view"])
        if not resposta and not aprendizado:
            self.set_status("Informe uma resposta aprovada ou regra nova.")
            return
        save_learning(cliente, rascunho, resposta, aprendizado)
        set_buffer_text(self.learn_text["view"], "")
        self.set_status("Aprendizado salvo localmente.")


class ProdataApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="local.prodata.agent")

    def do_activate(self):
        window = ProdataWindow(self)
        window.present()


def main():
    app = ProdataApp()
    app.run(None)


if __name__ == "__main__":
    main()
