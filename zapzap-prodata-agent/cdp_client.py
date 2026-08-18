import base64
import hashlib
import json
import os
import socket
import struct
import time
import urllib.request
from urllib.parse import urlparse


class CdpError(RuntimeError):
    pass


class CdpClient:
    def __init__(self, host="127.0.0.1", port=9222):
        self.host = host
        self.port = port
        self.sock = None
        self.next_id = 1

    def targets(self):
        with urllib.request.urlopen(f"http://{self.host}:{self.port}/json", timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))

    def connect_whatsapp(self):
        targets = self.targets()
        page_targets = [item for item in targets if item.get("type") == "page"]
        target = None
        priority_checks = (
            ("web.whatsapp.com",),
            ("whatsapp",),
            ("zapzap",),
        )
        for needles in priority_checks:
            for item in page_targets:
                title = (item.get("title") or "").lower()
                url = (item.get("url") or "").lower()
                if any(needle in title or needle in url for needle in needles):
                    target = item
                    break
            if target:
                break
        if not target and page_targets:
            for item in page_targets:
                url = (item.get("url") or "").lower()
                if url.startswith("chrome://") or url.startswith("about:blank"):
                    continue
                target = item
                break
        if not target and page_targets:
            target = page_targets[0]
        if not target:
            raise CdpError("Nenhuma aba de pagina encontrada na porta 9222.")
        self.connect_ws(target["webSocketDebuggerUrl"])
        self.call("Runtime.enable")
        return target

    def connect_ws(self, url):
        parsed = urlparse(url)
        host = parsed.hostname or self.host
        port = parsed.port or self.port
        path = parsed.path
        if parsed.query:
            path += "?" + parsed.query

        sock = socket.create_connection((host, port), timeout=3)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode("ascii"))
        response = sock.recv(4096)
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise CdpError("Falha ao conectar no WebSocket do ZapZap.")
        expected = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        )
        if expected not in response:
            raise CdpError("Handshake WebSocket invalido.")
        self.sock = sock

    def call(self, method, params=None, timeout=6):
        if not self.sock:
            raise CdpError("CDP nao conectado.")
        message_id = self.next_id
        self.next_id += 1
        payload = {"id": message_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.send_frame(json.dumps(payload))

        end = time.time() + timeout
        while time.time() < end:
            message = self.recv_frame()
            if not message:
                continue
            data = json.loads(message)
            if data.get("id") == message_id:
                if "error" in data:
                    raise CdpError(str(data["error"]))
                return data.get("result", {})
        raise CdpError(f"Timeout chamando {method}.")

    def send_frame(self, text):
        data = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self.sock.sendall(header + masked)

    def recv_exact(self, count):
        chunks = []
        remaining = count
        while remaining:
            chunk = self.sock.recv(remaining)
            if not chunk:
                raise CdpError("Conexao WebSocket fechada.")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def recv_frame(self):
        first = self.recv_exact(2)
        opcode = first[0] & 0x0F
        length = first[1] & 0x7F
        masked = first[1] & 0x80
        if length == 126:
            length = struct.unpack("!H", self.recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self.recv_exact(8))[0]
        mask = self.recv_exact(4) if masked else b""
        payload = self.recv_exact(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        if opcode == 8:
            raise CdpError("WebSocket fechado pelo ZapZap.")
        if opcode != 1:
            return ""
        return payload.decode("utf-8", errors="replace")

    def evaluate(self, expression, timeout=8):
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
            timeout=timeout,
        )
        remote = result.get("result", {})
        if "value" in remote:
            return remote["value"]
        return ""


MESSAGE_ROWS_JS = r"""
(() => {
  const root = document.querySelector('#main');
  if (!root) return '[]';
  const ownNames = ['prodata gurupi', 'você', 'voce'];
  const messageNodes = Array.from(root.querySelectorAll('[data-pre-plain-text]'));
  if (!messageNodes.length) return '[]';
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
  return JSON.stringify(rows.slice(-18));
})()
"""

EXTRACT_CONTEXT_JS = r"""
(() => {
  const rows = JSON.parse(%s);
  return rows.map((row) => `${row.mine ? 'EU' : 'CLIENTE'}: ${row.text}`).join('\n');
})()
""" % MESSAGE_ROWS_JS


FILL_RESPONSE_JS = r"""
(async (text) => {
  const boxes = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
  const box = boxes.reverse().find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 80 && rect.height > 20 && !el.closest('[aria-hidden="true"]');
  });
  if (!box) return false;
  box.focus();
  if (box.tagName === 'TEXTAREA') {
    box.value = text;
    box.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
    return true;
  }
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  box.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
  return true;
})(%s)
"""
