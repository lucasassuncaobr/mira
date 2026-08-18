#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from datetime import datetime
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
import base64
import json
import re
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any
import io

try:
    from openai import OpenAI
except Exception:
    OpenAI = None

from PIL import Image

try:
    import torch
except Exception:
    torch = None

try:
    from transformers import AutoModelForCausalLM, AutoTokenizer
except Exception:
    AutoModelForCausalLM = None
    AutoTokenizer = None


ROOT = Path(__file__).resolve().parent

# Config
MEMORY_FILES = [
    "memoria/perfil_atendimento.md",
    "memoria/prodata_faq.md",
    "memoria/procedimentos.md",
    "memoria/frases_padrao.md",
    "memoria/aprendizados.md",
    "memoria/manuals_knowledge.md",
    "memoria/sicap_ap_knowledge.md",
]
COMPACT_MEMORY_FILES = [f for f in MEMORY_FILES if "aprendizados" not in f]
MODEL_FILE = ROOT / "modelo.txt"
DEFAULT_MODEL = "mimo/mimo-auto"
MODEL_ALIASES = {
    "mimo-v2.5-free": "xiaomi/mimo-v2.5",
    "mimo-v2.5": "xiaomi/mimo-v2.5",
    "mimo-v2.5-pro": "xiaomi/mimo-v2.5-pro",
    "mimo-v2.5-pro-ultraspeed": "xiaomi/mimo-v2.5-pro-ultraspeed",
    "mimo-auto": "mimo/mimo-auto",
}
MIMO_API_KEY_FILE = ROOT / ".mimo_api_key"
DEEPSEEK_API_KEY_FILE = ROOT / ".deepseek_api_key"
QWEN_API_KEY_FILE = ROOT / ".qwen_api_key"
MIMO_CLI_CANDIDATES = (
    os.environ.get("MIMO_CLI", "").strip(),
    "/home/lucasassuncao/mimo-cli/bin/mimo",
    str(Path.home() / "mimo-cli/bin/mimo"),
    shutil.which("mimo") or "",
)
MIMO_BASE_URL = os.environ.get("MIMO_BASE_URL", "https://opencode.ai").strip().rstrip("/")
MIMO_TIMEOUT_SECONDS = float(os.environ.get("MIMO_TIMEOUT_SECONDS", "1.5"))
MIMO_CLI_TIMEOUT_SECONDS = float(os.environ.get("MIMO_CLI_TIMEOUT_SECONDS", "30.0"))
MIMO_FINAL_WAIT_SECONDS = float(os.environ.get("MIMO_FINAL_WAIT_SECONDS", "18.0"))
DEEPSEEK_TIMEOUT_SECONDS = float(os.environ.get("DEEPSEEK_TIMEOUT_SECONDS", "1.0"))
QWEN_TIMEOUT_SECONDS = float(os.environ.get("QWEN_TIMEOUT_SECONDS", "2.4"))
DUAL_ENGINE_TIMEOUT_SECONDS = float(os.environ.get("DUAL_ENGINE_TIMEOUT_SECONDS", "2.8"))
MIMO_VISION_TIMEOUT_SECONDS = float(os.environ.get("MIMO_VISION_TIMEOUT_SECONDS", "1.5"))
QWEN_LAST_CHANCE_SECONDS = float(os.environ.get("QWEN_LAST_CHANCE_SECONDS", "1.2"))
QWEN_ENABLED = os.environ.get("QWEN_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
MOONDREAM_ENABLED = os.environ.get("MOONDREAM_ENABLED", "0").strip().lower() not in {"0", "false", "no"}
MOONDREAM_DEVICE = os.environ.get("MOONDREAM_DEVICE", "").strip()
LOCAL_QWEN_TRIAGE_ENABLED = False
LOCAL_QWEN_TRIAGE_MODEL = os.environ.get("LOCAL_QWEN_TRIAGE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct").strip() or "Qwen/Qwen2.5-0.5B-Instruct"
LOCAL_QWEN_TRIAGE_DEVICE = os.environ.get("LOCAL_QWEN_TRIAGE_DEVICE", "").strip()
LOCAL_QWEN_RESPONSE_ENABLED = False
LOCAL_QWEN_MAX_NEW_TOKENS = int(os.environ.get("LOCAL_QWEN_MAX_NEW_TOKENS", "48"))
LOCAL_QWEN_WAIT_SECONDS = float(os.environ.get("LOCAL_QWEN_WAIT_SECONDS", "35.0"))
LOCAL_AI_ONLY_TEST = os.environ.get("LOCAL_AI_ONLY_TEST", "0").strip().lower() not in {"0", "false", "no"}

# === OLLAMA CONFIG ===
OLLAMA_ENABLED = os.environ.get("OLLAMA_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").strip().rstrip("/")
LOCAL_FAST_GRACE_SECONDS = float(os.environ.get("LOCAL_FAST_GRACE_SECONDS", "0.12"))
ENGINE_SETTLE_SECONDS = float(os.environ.get("ENGINE_SETTLE_SECONDS", "0.15"))
MAX_LEARNED_LINES = 120
MAX_HISTORY_EXAMPLES = 6
MAX_MANUAL_HITS = 2
MANUALS_CORPUS_FILE = ROOT / "dados" / "manuals_corpus.jsonl"
MANUALS_INDEX_FILE = ROOT / "dados" / "manuals_index.json"
ALLOWED_MANUAL_MODULES = {
    "compras", "arrecadacoes", "gestao pessoal folha",
    "protocolo e atendimento", "almoxarifado e estoque",
}
MANUAL_STOPWORDS = {
    "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos",
    "e", "em", "na", "nas", "no", "nos", "ou", "para", "por", "que",
    "um", "uma", "os", "se", "seu", "sua", "isso", "essa", "esse",
    "este", "esta",
}
MANUAL_MODULE_RULES = [
    ("gestao pessoal folha", [r"sicap", r"folha", r"pessoal", r"auditoria", r"atos de pessoal", r"remessa", r"teto constitucional", r"\bcpf\b", r"\bvinculo\b", r"\bvínculo\b", r"matr[ií]cula"]),
    ("arrecadacoes", [r"arrecad", r"\bduam\b", r"taxa", r"receita", r"guia", r"tribut", r"iptu", r"iss", r"itbi", r"parcela", r"cobranca", r"cobrança"]),
    ("protocolo e atendimento", [r"protocolo", r"glpi", r"chamado", r"rca", r"digital service", r"servi[cç]o cidad[aã]o", r"solicita[cç][aã]o"]),
    ("almoxarifado e estoque", [r"almoxarif", r"estoque", r"kardex", r"invent[aá]rio", r"transa[cç][aã]o de estoque", r"requisi[cç][aã]o de materiais", r"ems\b", r"produto"]),
    ("compras", [r"licita", r"preg[aã]o", r"\bcompra\b", r"empenho", r"requisi", r"pedido de compra", r"autoriza[cç][aã]o de entrega", r"ordem de fornecimento", r"anula[cç][aã]o de pedido", r"fornecedor", r"contrato", r"aditivo", r"apostil", r"julgamento", r"modalidade", r"mapa or[cç]ament", r"produto", r"\bpncp\b", r"edital", r"aviso", r"dispensa", r"inexigibilidade", r"ata de registro", r"termo de contrato", r"plano de contrata"]),
]
MANUAL_TRIGGER_PATTERNS = [
    r"\bpncp\b", r"\bsicap\b", r"\bfolha\b", r"\bpessoal\b",
    r"\barrecad", r"\bprotocolo\b", r"\bglpi\b", r"\bchamado\b",
    r"\balmoxarif", r"\bestoque\b", r"\bkardex\b", r"processo de compra",
    r"pedido de compra", r"requisi[cç][aã]o", r"contrato", r"fornecedor",
    r"empenho", r"edital", r"aviso", r"dispensa", r"inexigibilidade",
    r"guia", r"taxa", r"duam",
]
LOCAL_RESPONSE_BANK_FILE = ROOT / "dados" / "respostas_locais.json"
KNOWLEDGE_INDEX_FILE = ROOT / "memoria" / "knowledge_index.json"
QUALITY_REJECTS_FILE = ROOT / "dados" / "learning_rejects.jsonl"
LEARNING_MIN_CONFIDENCE = 0.58
KNOWLEDGE_CATEGORIES = {
    "acesso_login": ["senha", "acesso", "login", "reset", "desbloquear", "usuario", "usuário", "credencial", "autentic"],
    "compras": ["requisição", "requisicao", "empenho", "compra", "pedido", "cotação", "cotacao", "fornecedor"],
    "sicap": ["sicap", "folha", "pessoal", "remessa", "teto constitucional"],
    "cache": ["cache", "atualização", "atualizacao", "desatualizado", "ctrl f5", "recarregar"],
    "chamado": ["glpi", "chamado", "protocolo", "ticket"],
    "erro_sistema": ["erro", "bug", "travou", "falha", "não funciona", "nao funciona", "mensagem"],
    "certificado": ["certificado", "assinatura digital", "a1", "a3", "nota fiscal", "nfe", "nf-e"],
    "rede_ti": ["internet", "rede", "computador", "impressora", "scanner", "ti prefeitura"],
}
SOCIAL_LEARNING_PATTERNS = [
    r"^(oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem)[!.? ]*$",
    r"^(bom dia|boa tarde|boa noite)[,!.? ]+tudo bem[!.? ]*$",
    r"^(obrigad[oa]|valeu|ok|certo|beleza|t[aá] bom|ate mais|até mais)[!.? ]*$",
    r"^(posso te ligar|me liga|vou te ligar|s[oó] um momento)[?.! ]*$",
]
LOW_VALUE_ANSWER_PATTERNS = [
    r"^(ok|certo|beleza|t[aá] bom|sim|n[aã]o|s[oó] um momento|vou verificar|verificando)[!.? ]*$",
    r"^(oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|bom dia tudo bem|boa tarde tudo bem|boa noite tudo bem)[,!.? ]*$",
    r"^(bom dia|boa tarde|boa noite)[,!.? ]+tudo bem[!.? ]*$",
    r".*\bainda obtivemos retorno\b.*",
    r"^qualquer coisa.*disposi[cç][aã]o[!.? ]*$",
]
LOW_VALUE_QUESTION_PATTERNS = [
    r"^(preciso que voc[eê] fa[cç]a|pode me ajudar|me ajuda|ajuda aqui|tudo joia|tudo certo|bom dia|boa tarde|boa noite)[,!.? ]*$",
    r"^(bom dia|boa tarde|boa noite)[,!.? ]+tudo bem[!.? ]*$",
    r"^(sim|n[aã]o|ok|certo|beleza|ta bom|t[aá] bom)[,!.? ]*$",
]

# Greeting helpers
def _get_time_greeting() -> str:
    hour = datetime.now().hour
    if hour < 12:
        return "Bom dia"
    if hour < 18:
        return "Boa tarde"
    return "Boa noite"

def _greeting_probe(text: str) -> str:
    value = _normalize_manual_text(text)
    if not value:
        return ""
    value = re.sub(r"([a-zà-ÿ])[\s._,;:!?\-]+(?=[a-zà-ÿ])", r"\1 ", value)
    value = re.sub(r"\b(bom)\s*(dia)\b", r"\1 dia", value)
    value = re.sub(r"\b(boa)\s*(tarde|noite)\b", r"\1 \2", value)
    value = re.sub(r"\b(ol)\s*[aá]\b", "ola", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value

def _detect_greeting(text: str) -> str:
    clean = _greeting_probe(text)
    if not clean:
        return ""
    if re.search(r"\bbom\s+dia\b", clean):
        return "Bom dia"
    if re.search(r"\bboa\s+tarde\b", clean):
        return "Boa tarde"
    if re.search(r"\bboa\s+noite\b", clean):
        return "Boa noite"
    if re.search(r"\b(oi|ola|eai|e ai)\b", clean):
        return _get_time_greeting()
    return ""

def _is_greeting_only_turn(text: str) -> bool:
    clean = _greeting_probe(text)
    if not clean:
        return False
    without_greeting = re.sub(r"\b(bom\s+dia|boa\s+tarde|boa\s+noite|oi|ola|eai|e ai)\b", " ", clean)
    without_greeting = re.sub(r"\b(tudo\s+bem|td\s+bem|blz|beleza)\b", " ", without_greeting)
    without_greeting = re.sub(r"[^a-zà-ÿ0-9]+", " ", without_greeting)
    tokens = [token for token in without_greeting.split() if len(token) > 1]
    # Accept short name/addressing leftovers: "lucas bom dia", "joao paulo bom.dia".
    return bool(_detect_greeting(text)) and len(tokens) <= 3

def greeting_reply(text: str) -> str:
    clean = _greeting_probe(text)
    if not clean:
        return ""
    if _is_greeting_only_turn(text):
        greeting = _detect_greeting(text)
        return f"{greeting}, tudo bem?"
    if re.fullmatch(r"(oi|ola|eai|e ai)([.!?])?", clean):
        return f"{_get_time_greeting()}, tudo bem?"
    if re.fullmatch(r"(bom dia|boa tarde|boa noite)([,.!?\s]*(tudo bem[.!?]*)?|[.!?])", clean):
        greeting = "Bom dia" if clean.startswith("bom dia") else "Boa tarde" if clean.startswith("boa tarde") else "Boa noite"
        return f"{greeting}, tudo bem?"
    return ""

def greeting_prefix(text: str) -> str:
    greeting = _detect_greeting(text)
    if greeting:
        return f"{greeting}, tudo bem?"
    return ""

def apply_greeting_prefix(prefix: str, response: str) -> str:
    if not prefix:
        return response
    if _normalize_manual_text(response).startswith(("bom dia", "boa tarde", "boa noite", "olá", "ola")):
        return response
    return f"{prefix} {response}".strip()

def _get_greeting_for_response(text: str = "") -> str:
    greeting = _detect_greeting(text)
    if greeting:
        return greeting
    return _get_time_greeting()

# Text helpers
def _normalize_manual_text(text: str) -> str:
    return " ".join((text or "").split()).strip().lower()

def _manual_tokens(text: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-záàâãéèêíïóôõöúçñ0-9]{3,}", _normalize_manual_text(text))
        if token not in MANUAL_STOPWORDS
    }

def words(text: str) -> set[str]:
    return {word for word in re.findall(r"[a-záàâãéèêíïóôõöúçñ0-9]{3,}", text.lower()) if word not in {"cliente", "você", "voce", "para", "com", "que", "uma", "por", "aqui", "bom", "dia"}}

def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""

def _read_tail_lines(path: Path, limit: int) -> str:
    text = read_text(path)
    if not text:
        return ""
    lines = [line for line in text.splitlines() if line.strip()]
    return text.strip() if len(lines) <= limit else "\n".join(lines[-limit:]).strip()

def read_mimo_api_key() -> str:
    return os.environ.get("MIMO_API_KEY", "").strip() or read_text(MIMO_API_KEY_FILE)

def read_deepseek_api_key() -> str:
    return os.environ.get("DEEPSEEK_API_KEY", "").strip() or read_text(DEEPSEEK_API_KEY_FILE)

def read_qwen_api_key() -> str:
    return os.environ.get("QWEN_API_KEY", "").strip() or read_text(QWEN_API_KEY_FILE)

def resolve_mimo_remote_model() -> str:
    return os.environ.get("MIMO_REMOTE_MODEL", "mimo-v2.5-free").strip() or "mimo-v2.5-free"

def resolve_qwen_model() -> str:
    return os.environ.get("QWEN_MODEL", "qwen-turbo").strip() or "qwen-turbo"

@lru_cache(maxsize=1)
def _load_moondream_model():
    return None

def _engine_display_name(source: str) -> str:
    names = {
        "mimo": "MiMo",
        "mimo_visao": "MiMo Visao",
        "qwen": "Qwen",
        "banco_local": "Banco Local",
        "heuristica": "Resposta rapida",
        "fallback_minimo": "Fallback",
    }
    return names.get(source, source.title())

def _resolve_local_qwen_triage_device() -> str:
    if LOCAL_QWEN_TRIAGE_DEVICE:
        return LOCAL_QWEN_TRIAGE_DEVICE
    if torch is not None and hasattr(torch, "cuda") and torch.cuda.is_available():
        return "cuda"
    return "cpu"

@lru_cache(maxsize=1)
def _load_local_qwen_triage():
    return None

@lru_cache(maxsize=1)
def _load_local_qwen_model():
    if torch is None or AutoModelForCausalLM is None or AutoTokenizer is None:
        return None
    try:
        device = _resolve_local_qwen_triage_device()
        tokenizer = AutoTokenizer.from_pretrained(LOCAL_QWEN_TRIAGE_MODEL)
        model = AutoModelForCausalLM.from_pretrained(LOCAL_QWEN_TRIAGE_MODEL)
        if device != "cpu":
            model = model.to(device)
        model.eval()
        return {"tokenizer": tokenizer, "model": model, "device": device}
    except Exception:
        return None

@lru_cache(maxsize=1)
def _load_local_qwen_response():
    return None

def local_qwen_triage_should_escalate(current_query: str, conversation_context: str = "") -> bool | None:
    bundle = _load_local_qwen_triage()
    text = (current_query or "").strip() or _last_meaningful_line(conversation_context)
    if not text:
        return None
    normalized = _normalize_manual_text(text)
    if not normalized:
        return None
    if _is_greeting_only_turn(text):
        return False
    obvious_no_patterns = [
        r"^(ok|okay|certo|perfeito|beleza|blz|show|entendi|ta bom|tudo bem)([.!?,\s].*)?$",
        r"^(obrigad[oa]|obg|valeu|agrade[cç]o)([.!?,\s].*)?$",
        r"^(oi|ola|ol[aá]|bom dia|boa tarde|boa noite)([.!?,\s].*)?$",
        r"^(vou verificar|vou olhar|vou testar|vou tentar|vou conferir)([.!?,\s].*)?$",
    ]
    if any(re.match(pattern, normalized) for pattern in obvious_no_patterns):
        return False
    obvious_yes_terms = [
        "erro", "falha", "nao consegui", "não consegui", "problema", "atualizacao", "atualização",
        "acesso", "senha", "login", "permiss", "sicap", "requisicao", "requisição", "empenho",
        "nota", "certificado", "modulo", "módulo", "sistema", "tela", "print", "imagem",
        "travou", "nao abre", "não abre", "preciso que voce faca", "preciso que você faça",
    ]
    if any(term in normalized for term in obvious_yes_terms):
        return True
    if bundle is None:
        return None
    prompt = (
        "Voce faz triagem ultra-rapida de mensagens do SIG Prodata.\n"
        "Responda apenas SIM ou NAO.\n"
        "Responda NAO para agradecimento, encerramento, saudacao isolada, confirmacao curta, retorno social ou conversa sem demanda tecnica.\n"
        "Responda SIM quando houver erro, duvida tecnica, pedido de suporte, pedido de orientacao, mudanca de contexto, problema de acesso, imagem, tela, sistema, modulo, processo, requisicao, empenho, sicap ou qualquer necessidade real de resposta inteligente.\n"
        "Exemplos:\n"
        "- 'ok obrigada' => NAO\n"
        "- 'valeu' => NAO\n"
        "- 'bom dia' => NAO\n"
        "- 'nao consegui acessar' => SIM\n"
        "- 'meu prodata pede atualizacao' => SIM\n"
        "- 'preciso que voce faca no sicap' => SIM\n"
        f"Contexto recente da conversa: {_recent_context_window(conversation_context, limit=4) or '(sem contexto)'}\n"
        f"Mensagem do cliente: {text}"
    )
    try:
        tokenizer = bundle["tokenizer"]
        model = bundle["model"]
        device = bundle["device"]
        chat = tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False,
            add_generation_prompt=True,
        )
        model_inputs = tokenizer([chat], return_tensors="pt")
        if hasattr(model_inputs, "to"):
            model_inputs = model_inputs.to(device)
        with torch.no_grad():
            generated_ids = model.generate(
                **model_inputs,
                max_new_tokens=4,
                do_sample=False,
            )
        completion = tokenizer.batch_decode(generated_ids[:, model_inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip().upper()
    except Exception:
        return None
    if completion.startswith("SIM"):
        return True
    if completion.startswith("NAO") or completion.startswith("NÃO"):
        return False
    return None

def local_qwen_generate(prompt: str, max_new_tokens: int = 180) -> str:
    bundle = _load_local_qwen_response()
    if bundle is None:
        raise RuntimeError("Nao consegui carregar o Qwen local.")
    tokenizer = bundle["tokenizer"]
    model = bundle["model"]
    device = bundle["device"]
    chat = tokenizer.apply_chat_template(
        [
            {
                "role": "system",
                "content": (
                    "Voce e um modelo local do SIG Prodata, usado como segunda opiniao do atendente. "
                    "Fale em portugues do Brasil, com naturalidade de colega de suporte, sem soar robótico. "
                    "Use contexto recente com prioridade, mas mantenha liberdade para ajustar o tom e a empatia. "
                    "Nao seja generico, nao repita frases padrao e nao invente fluxo inexistente. "
                    "Se a conversa estiver encerrada, responda com fechamento curto e humano. "
                    "Se a conversa estiver aberta ou a pessoa pedir ajuda mais ampla, nao responda seco demais: desenvolva um pouco mais, em 2 a 4 frases curtas. "
                    "Se houver erro, siga o ponto exato da tela ou da mensagem recente."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        tokenize=False,
        add_generation_prompt=True,
    )
    model_inputs = tokenizer([chat], return_tensors="pt")
    if hasattr(model_inputs, "to"):
        model_inputs = model_inputs.to(device)
    try:
        with torch.no_grad():
            generated_ids = model.generate(
                **model_inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
            )
        completion = tokenizer.batch_decode(
            generated_ids[:, model_inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
        )[0].strip()
        return completion
    except Exception as exc:
        raise RuntimeError("Falha ao gerar com o Qwen local.") from exc

# === OLLAMA GENERATE FUNCTIONS ===

def _ollama_generate(model: str, prompt: str, system: str = "", max_tokens: int = 260, timeout: float = 30) -> str:
    """Gera resposta usando Ollama local via API HTTP."""
    url = f"{OLLAMA_BASE_URL}/api/chat"
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "think": False,
        "options": {
            "num_predict": max_tokens,
            "num_ctx": 1024,
            "temperature": 0.3,
            "top_p": 0.9,
        }
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            chunks = []
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = item.get("message") or {}
                content = str(message.get("content") or "")
                if content:
                    chunks.append(content)
                if item.get("done"):
                    break
            raw = "".join(chunks)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Nao consegui falar com o Ollama ({model}).") from exc
    return _strip_model_thinking(raw)


def _strip_model_thinking(text: str) -> str:
    value = str(text or "").strip()
    value = re.sub(r"<think>.*?</think>", "", value, flags=re.I | re.S).strip()
    value = re.sub(r"(?is)<think>.*$", "", value).strip()
    value = re.sub(r"(?is)^thinking\.\.\..*?done thinking\.?", "", value).strip()
    value = re.sub(r"(?is)^the user wrote.*?final answer:?", "", value).strip()
    value = value.strip().strip('"').strip("'").strip()
    return value


def _ollama_generate_raw(model: str, prompt: str, max_tokens: int = 96, timeout: float = 30) -> str:
    url = f"{OLLAMA_BASE_URL}/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "raw": True,
        "think": False,
        "options": {
            "num_predict": max_tokens,
            "num_ctx": 512,
            "temperature": 0.1,
            "top_p": 0.85,
            "stop": ["\nCLIENTE:", "\nATENDENTE:", "<|im_end|>"],
        },
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            chunks = []
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                chunk = str(item.get("response") or "")
                if chunk:
                    chunks.append(chunk)
                if item.get("done"):
                    break
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Nao consegui falar com o Ollama ({model}).") from exc
    return _strip_model_thinking("".join(chunks))


def build_local_qwen_prompt(
    current_query: str,
    conversation_context: str,
    local_guidance: str = "",
    visual_context: str = "",
) -> str:
    recent_context = _recent_context_window(conversation_context, limit=6).strip()
    recent_guidance = _recent_context_window(local_guidance, limit=4).strip()
    last_customer = _last_customer_line(conversation_context, current_query, local_guidance).strip()
    parts = [
        "Voce e um modelo local do SIG Prodata.",
        "Sua funcao e sugerir a melhor resposta para o atendente, com foco em contexto, objetividade, naturalidade e tom humano.",
        "Priorize a mensagem mais recente do cliente e o historico recente. Se o assunto mudou, siga o assunto novo.",
        "Se a conversa ja estiver resolvida, responda com fechamento curto, humano e cordial.",
        "Se a conversa estiver aberta, a demanda estiver incompleta ou a pessoa pedir orientacao mais ampla, responda com mais calor humano e um pouco mais de desenvolvimento, sem virar texto longo.",
        "Evite resposta generica e evite repetir frases prontas sem necessidade.",
        "Se faltar informacao, faça uma sugestao curta de continuidade e nao invente detalhe.",
        "Se o cliente parecer confuso, frustrado ou precisar de acolhimento, responda com empatia simples, sem exagero.",
        f"Mensagem atual do cliente: {current_query or '(sem mensagem)'}",
        f"Ultima mensagem relevante do cliente: {last_customer or '(indisponivel)'}",
    ]
    if visual_context.strip():
        parts.append(f"Contexto visual relevante: {visual_context.strip()}")
    if recent_guidance:
        parts.append(f"Base local relevante:\n{recent_guidance}")
    if recent_context:
        parts.append(f"Historico recente da conversa:\n{recent_context}")
    parts.append(
        "Formato desejado: 1 a 3 frases curtas, humanas, com boa adesao ao contexto. "
        "Se a demanda estiver aberta, use 2 a 4 frases curtas em vez de uma resposta curta demais. "
        "Se a conversa estiver em encerramento, seja breve e cordial. "
        "Se houver abertura para conversa, use uma saudacao leve e natural."
    )
    return "\n".join(parts)


def warm_local_support_models() -> None:
    try:
        _load_local_qwen_triage()
    except Exception:
        pass
    try:
        _load_moondream_model()
    except Exception:
        pass

def _source_priority(source: str) -> int:
    priorities = {
        "qwen": 6,
        "mimo": 5,
        "mimo_visao": 5,
        "heuristica": 2,
        "banco_local": 1,
        "fallback_minimo": 0,
    }
    return priorities.get(source, 0)

def _last_customer_line(conversation_context: str = "", cliente: str = "", rascunho: str = "") -> str:
    if cliente.strip():
        return cliente.strip()
    lines = [line.strip() for line in (conversation_context or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if line.lower().startswith("cliente:"):
            return re.sub(r"^cliente:\s*", "", line, flags=re.I).strip()
    return _last_meaningful_line(cliente, rascunho, conversation_context)

def _is_lightweight_turn(text: str) -> bool:
    normalized = _normalize_manual_text(text)
    if not normalized:
        return False
    short = len(normalized) <= 90
    if short and _is_greeting_only_turn(text):
        return True
    relationship_patterns = [
        r"^(oi|ol[aá]|e ai|eai|bom dia|boa tarde|boa noite)([.!?,\s].*)?$",
        r"^(ok|okay|certo|perfeito|beleza|blz|show|entendi|t[aá] bom|tudo bem)([.!?,\s].*)?$",
        r"^(obrigad[oa]|obg|valeu|agrade[cç]o)([.!?,\s].*)?$",
        r"^(posso te ligar|pode ligar|puder me ligar|me liga)([.!?,\s].*)?$",
    ]
    return short and any(re.match(pattern, normalized) for pattern in relationship_patterns)

def _recent_context_window(conversation_context: str, limit: int = 4) -> str:
    lines = [line.strip() for line in (conversation_context or "").splitlines() if line.strip()]
    return "\n".join(lines[-limit:])

def contextual_followup_reply(current_query: str, conversation_context: str, modo: str = "profissional") -> str:
    query = _normalize_manual_text(current_query)
    recent = _normalize_manual_text(_recent_context_window(conversation_context, limit=6))
    unresolved_followup = any(term in query for term in ["nao consegui", "não consegui", "continua", "ainda", "mesmo erro", "nao deu", "não deu"])
    if not unresolved_followup:
        return ""
    if any(term in recent for term in ["atualizacao", "atualização", "cache", "ctrl + f5", "ctrl f5", "ctrl + shift + r"]):
        return "Certo, aplicou o Ctrl + F5? Me avise se resolveu ou se continua aparecendo a mensagem de atualização."
    if any(term in recent for term in ["login", "senha", "acesso", "sessao", "sessão", "usuario", "usuário"]):
        return "Entendi. Continua aparecendo a mesma mensagem de acesso? Se puder, me envie o texto exato ou um print para eu te orientar no próximo passo."
    if any(term in recent for term in ["empenho", "ficha", "fonte", "orcamento", "orçamento"]):
        return "Entendi. Continua travando na mesma etapa? Se puder, me envie um print dessa tela ou confirme qual campo ainda não está aparecendo."
    if any(term in recent for term in ["requisicao", "requisição", "processo de compra", "cotacao", "cotação"]):
        return "Certo. Continua na mesma etapa da requisição? Me confirme o ponto exato onde travou ou me envie um print da tela para eu orientar o próximo passo."
    return ""

def _is_generic_response(text: str) -> bool:
    normalized = _normalize_manual_text(text)
    if not normalized:
        return True
    generic_patterns = [
        r"^certo[,.! ]+qualquer coisa[, ]+fico a disposicao",
        r"^disponha[!. ]+qualquer coisa[, ]+e so me chamar",
        r"^me diga o modulo do sig prodata",
        r"^ola[!. ]+como posso ajudar",
        r"^olá[!. ]+como posso ajudar",
        r"^como posso ajudar voce hoje",
        r"^como posso ajudar você hoje",
        r"^abra um chamado",
        r"^me envie um print",
        r"^so um momento que ja verifico",
    ]
    return any(re.search(pattern, normalized) for pattern in generic_patterns)

def _is_weak_context_question(text: str) -> bool:
    normalized = _normalize_manual_text(text)
    if not normalized:
        return True
    weak_fragments = (
        "onde fica a tela",
        "qual e o subgrupo",
        "qual é o subgrupo",
        "eu consigo ser mais preciso",
        "consigo ser mais preciso",
        "preciso de mais contexto",
        "me diga o modulo",
        "me diga o módulo",
        "me informe a tela",
        "qual tela",
    )
    question_count = text.count("?")
    has_weak_fragment = any(fragment in normalized for fragment in weak_fragments)
    has_domain_action = any(
        term in normalized
        for term in (
            "cadastro",
            "parametrizacao",
            "parametrização",
            "vincul",
            "compras",
            "licit",
            "processo",
            "requisicao",
            "requisição",
            "autorizacao",
            "autorização",
            "empenho",
            "ficha",
            "fonte",
            "elemento",
            "detalhamento",
        )
    )
    return (has_weak_fragment or question_count >= 3) and not has_domain_action

def _candidate_score(source: str, text: str, current_query: str, conversation_context: str, has_visual_context: bool) -> int:
    normalized = _normalize_manual_text(text)
    if not normalized:
        return -100
    query_tokens = words(current_query or "")
    response_tokens = words(text)
    context_tokens = words(_recent_context_window(conversation_context))
    score = 0
    overlap_query = len(query_tokens & response_tokens)
    overlap_context = len(context_tokens & response_tokens)
    score += overlap_query * 5
    score += overlap_context * 2
    if 60 <= len(text) <= 360:
        score += 3
    elif len(text) < 36:
        score -= 6
    elif len(text) > 520:
        score -= 2
    low_query = _normalize_manual_text(current_query)
    unresolved_followup = any(term in low_query for term in ["nao consegui", "não consegui", "continua", "ainda", "mesmo erro", "nao deu", "não deu"])
    if unresolved_followup:
        if _is_generic_response(text):
            score -= 14
        if any(term in normalized for term in ["erro", "mensagem", "print", "atualizacao", "cache", "acesso", "permiss", "sessao", "sessão"]):
            score += 4
        if "?" in text or any(term in normalized for term in ["me avise", "continua", "me envie", "qual mensagem", "qual erro"]):
            score += 3
        if source == "banco_local":
            score -= 6
    if has_visual_context and source.startswith("mimo"):
        score += 8
    if has_visual_context and source == "qwen":
        score += 2
    if source.startswith("mimo"):
        score += 2
    if source == "qwen":
        score += 4
    if source == "banco_local":
        score += 3
        if has_visual_context:
            score -= 1
    if _is_generic_response(text):
        score -= 5
    return score


def _sanitize_candidate_text(source: str, text: str) -> str:
    value = (text or "").strip()
    return value


def _build_candidate(source: str, text: str, elapsed_ms: int, current_query: str, conversation_context: str, has_visual_context: bool) -> dict[str, Any]:
    text = _sanitize_candidate_text(source, text)
    return {
        "source": source,
        "label": _engine_display_name(source),
        "text": text.strip(),
        "elapsed_ms": int(elapsed_ms),
        "judge_score": _candidate_score(source, text, current_query, conversation_context, has_visual_context),
    }

def _pick_winner(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    valid = [candidate for candidate in candidates if (candidate.get("text") or "").strip()]
    if not valid:
        return None
    return max(
        valid,
        key=lambda item: (
            int(item.get("judge_score") or 0),
            _source_priority(str(item.get("source") or "")),
            -int(item.get("elapsed_ms") or 0),
            -len(item.get("text") or ""),
        ),
    )

def _finalize_candidates(
    candidates: list[dict[str, Any]],
    errors: list[dict[str, str]],
    started_at: float,
    cliente: str,
    rascunho: str,
    modo: str,
) -> dict[str, Any]:
    winner = _pick_winner(candidates)
    if winner is None:
        fallback_text = contextual_fallback(cliente, rascunho, modo)
        winner = _build_candidate("fallback_minimo", fallback_text, int((time.monotonic() - started_at) * 1000), "", "", False)
        candidates.append(winner)
    for candidate in candidates:
        candidate["winner"] = candidate["source"] == winner["source"] and candidate["text"] == winner["text"]
    ordered = sorted(
        [candidate for candidate in candidates if (candidate.get("text") or "").strip()],
        key=lambda item: (0 if item.get("winner") else 1, int(item.get("elapsed_ms") or 0), -int(item.get("judge_score") or 0)),
    )
    return {
        "final_text": winner["text"],
        "final_source": winner["source"],
        "elapsed_ms": int((time.monotonic() - started_at) * 1000),
        "candidates": ordered,
        "errors": errors,
    }

def _last_meaningful_line(*parts: str) -> str:
    for part in reversed([p for p in parts if p]):
        lines = [line.strip() for line in str(part).splitlines() if line.strip()]
        for line in reversed(lines):
            cleaned = re.sub(r"^(eu|cliente):\s*", "", line, flags=re.I).strip()
            if cleaned:
                return cleaned
    return ""

def extract_last_customer_message(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if not line.lower().startswith("cliente:"):
            continue
        return re.sub(r"^cliente:\s*", "", line, flags=re.I).strip()
    return _last_meaningful_line(text)

def is_bad_text(text: str) -> bool:
    low = " ".join((text or "").split()).lower()
    return any(fragment in low for fragment in ["wds-", "ic-", "tail-", "forward-", "conversar", "mostrar empresa", "editar", "editada", "lista", "chat", "mensagem citada", "digite uma mensagem", "criptografia de ponta a ponta"])

def is_valid_pair(question: str, answer: str) -> bool:
    question = " ".join((question or "").split())
    answer = " ".join((answer or "").split())
    if len(question) < 8 or len(answer) < 8:
        return False
    if is_bad_text(question) or is_bad_text(answer):
        return False
    if question.lower().startswith(("você ", "voce ")) or answer.lower().startswith(("você ", "voce ")):
        return False
    if question.lower().startswith("http") and answer.lower().startswith("http"):
        return False
    if sum(1 for word in re.findall(r"\w+", question)) < 2 or sum(1 for word in re.findall(r"\w+", answer)) < 2:
        return False
    return True


def is_learning_candidate(question: str, answer: str) -> bool:
    question = " ".join((question or "").split())
    answer = " ".join((answer or "").split())
    if not question or not answer:
        return False
    if is_bad_text(question) or is_bad_text(answer):
        return False
    if len(answer) < 4:
        return False
    if question.lower().startswith(("você ", "voce ")):
        return False
    if question.lower().startswith("http") and answer.lower().startswith("http"):
        return False
    q_words = len(re.findall(r"\w+", question))
    a_words = len(re.findall(r"\w+", answer))
    if q_words < 1 or a_words < 1:
        return False
    if q_words < 2 and a_words < 2 and len(question) < 10:
        return False
    return True

# Automatic responses
SICAP_REPLY_TEMPLATE = (
    "{greeting}! Tudo bem?\n\n"
    "Sobre sua solicitação, a Secretaria de Tecnologia informou que não temos autorização para realizar ajustes nos arquivos do SICAP/AP.\n\n"
    "Cada órgão será responsável pela preparação e envio dos próprios arquivos.\n\n"
    "Se precisarem de orientações ou tiverem dúvidas, é só abrir um chamado que ajudaremos.\n\n"
    "As regras e o layout estão disponíveis aqui:\n"
    "https://www.tceto.tc.br/wp-content/uploads/2025/12/Portaria.pdf"
)

ACCESS_REPLY_TEMPLATE = (
    "{greeting}! Tudo bem?\n\n"
    "Para solicitar o reset do seu usuário ou da sua senha, é só entrar em contato com a equipe de TI da Prefeitura.\n\n"
    "Segue o contato:\n"
    "📞 +55 63 3301-4304\n\n"
    "Por lá, eles conseguem te ajudar com essa solicitação."
)

CACHE_REPLY_TEMPLATE = (
    "Provavelmente você está visualizando uma versão em cache.\n\n"
    "Se preferir, posso fazer esse procedimento para você. Basta me informar o acesso do AnyDesk.\n\n"
    "Enquanto isso, tente uma atualização forçada da página:\n\n"
    "Chrome, Edge, Brave, Opera e Firefox:\n"
    "Ctrl + F5 ou Ctrl + Shift + R"
)

SICAP_TRIGGERS = ["sicap", "sicap ap", "sicap/ap", "folha de pagamento", "gestao de pessoal", "gestão de pessoal"]
ACCESS_PATTERNS = [
    r"reset(?:ar)?\s+(?:o\s+)?(?:meu\s+)?(?:usuario|usu[aá]rio)",
    r"reset(?:ar)?\s+(?:a\s+)?(?:minha\s+)?senha",
    r"reset(?:ar)?\s+(?:o\s+)?(?:meu\s+)?login",
    r"liberar\s+(?:o\s+)?(?:meu\s+)?(?:acesso|usuario|usu[aá]rio|login)",
    r"desbloquear\s+(?:o\s+)?(?:meu\s+)?(?:acesso|usuario|usu[aá]rio|login|senha)",
    r"reativar\s+(?:o\s+)?(?:meu\s+)?(?:acesso|usuario|usu[aá]rio|login)",
    r"renovar\s+(?:o\s+)?(?:meu\s+)?(?:acesso|usuario|usu[aá]rio|login|senha)",
    r"renova(?:r)?\s+(?:acesso|login|usuario|usu[aá]rio|senha)",
    r"recuperar\s+(?:o\s+)?(?:meu\s+)?(?:acesso|login|usuario|usu[aá]rio|senha)",
    r"recupera(?:r)?\s+(?:acesso|login|usuario|usu[aá]rio|senha)",
    r"(?:trocar|mudar)\s+(?:a\s+)?senha",
    r"esqueci\s+(?:a\s+)?senha",
    r"esqueci\s+(?:o\s+)?(?:meu\s+)?(?:login|usuario|usu[aá]rio)",
    r"n[aã]o\s+lembro\s+(?:a\s+)?(?:minha\s+)?senha",
    r"n[aã]o\s+lembro\s+(?:o\s+)?(?:meu\s+)?(?:login|usuario|usu[aá]rio)",
    r"(?:problema|erro)\s+(?:ao|para|de)\s+(?:logar|entrar|acessar)",
    r"(?:problema|erro)\s+(?:no|com\s+o|de)\s+(?:login|usuario|usu[aá]rio|senha|acesso)",
    r"n[aã]o\s+consigo\s+(?:logar|entrar|acessar|abrir)",
    r"n[aã]o\s+(?:estou\s+)?conseguindo\s+(?:logar|entrar|acessar|abrir)",
    r"n[aã]o\s+(?:tenho|tenho mais)\s+acesso",
    r"(?:estou|to|t[oô])\s+sem\s+acesso",
    r"sem\s+acesso\s+(?:ao|no|a[o]?)?\s*(?:prodata|sig|sistema|usuario|usu[aá]rio|login)?",
    r"acesso\s+(?:ao|a[o]?|no|do|de)\s+(?:prodata|sig|sistema|usuario|usu[aá]rio|login)",
    r"(?:usuario|usu[aá]rio|login|acesso|senha)\s+(?:est[aá]\s+)?(?:bloqueado|bloqueada|travado|travada|cancelado|cancelada|suspenso|suspensa|expirado|expirada|vencido|vencida)",
    r"perdi\s+(?:o\s+)?(?:meu\s+)?(?:usuario|usu[aá]rio|acesso|senha|login)",
    r"perdi\s+acesso\s+(?:ao|a[o]?|no|do)?\s*(?:prodata|sig|sistema)?",
    r"bloquearam\s+(?:o\s+)?(?:meu\s+)?(?:usuario|usu[aá]rio)",
    r"bloqueou\s+(?:o\s+)?(?:meu\s+)?(?:usuario|usu[aá]rio|login|acesso|senha)",
    r"(?:minha|meu)\s+(?:conta|senha|usuario|usu[aá]rio|login|acesso)\s+(?:bloqueou|bloqueado|bloqueada|travou|travado|travada|expirou|expirado|expirada|venceu|vencido|vencida)",
    r"minha\s+(?:conta|senha|usuario|usu[aá]rio)",
    r"(?:login|senha|usuario|usu[aá]rio|acesso)\s+(?:n[aã]o\s+)?(?:funciona|valido|v[aá]lido|errado|errada|incorreto|incorreta|invalido|inv[aá]lido|invalida|inv[aá]lida)",
    r"n[aã]o\s+(?:entro|consigo\s+entrar)",
    r"n[aã]o\s+entra\s+(?:no|na|ao|a[o]?)?\s*(?:prodata|sig|sistema)?",
    r"n[aã]o\s+abre\s+(?:o\s+)?(?:prodata|sig|sistema)",
    r"(?:prodata|sig|sistema)\s+n[aã]o\s+(?:entra|abre|acessa|loga)",
    r"(?:prodata|sig|sistema)\s+(?:pede|pedindo|solicita|solicitando)\s+(?:login|senha|usuario|usu[aá]rio)",
    r"(?:prodata|sig|sistema).{0,40}(?:senha|login|usuario|usu[aá]rio|acesso).{0,40}(?:bloquead|trav|invalid|inv[aá]lid|errad|expir|venc)",
    r"(?:senha|login|usuario|usu[aá]rio|acesso).{0,40}(?:prodata|sig|sistema).{0,40}(?:bloquead|trav|invalid|inv[aá]lid|errad|expir|venc)",
    r"senha\s+(?:errada|incorreta|invalida|inv[aá]lida)",
    r"usuario\s+(?:errado|invalido|inv[aá]lido)",
    r"credenciais?\s+(?:invalidas|inv[aá]lidas|erradas|incorretas)",
    r"autentic(?:a[cç][aã]o|ar)\s+(?:falhou|erro|inv[aá]lida)",
    r"falha\s+(?:de|na)\s+autentic(?:a[cç][aã]o|ar)",
    r"erro\s+de\s+autentic(?:a[cç][aã]o|ar)",
    r"primeiro\s+acesso",
    r"novo\s+acesso",
    r"criar\s+(?:usuario|usu[aá]rio|login|acesso)",
    r"preciso\s+(?:de\s+)?(?:acesso|login|senha|usuario|usu[aá]rio)",
    r"preciso\s+(?:renovar|reativar|recuperar|resetar)\s+(?:o\s+)?(?:meu\s+)?(?:acesso|login|senha|usuario|usu[aá]rio)",
    r"quero\s+(?:acesso|login|senha|usuario|usu[aá]rio)",
    r"como\s+(?:fa[cç]o\s+para\s+)?(?:recuperar|resetar|trocar|desbloquear).{0,30}(?:senha|login|usuario|usu[aá]rio|acesso)",
]
CACHE_PATTERNS = [
    "cache", "versao em cache", "versão em cache", "atualizacao da pagina",
    "atualização da pagina", "pagina desatualizada", "página desatualizada",
    "desatualizada", "desatualizado", "nao atualiza", "não atualiza",
    "nao muda", "não muda", "versao antiga", "versão antiga", "versao velha",
    "versão velha", "atualizar pagina", "atualizar página", "atualizo",
    "recarregar pagina", "recarregar página", "ctrl f5", "ctrl shift r",
    "forcar atualizacao", "forçar atualização", "prodata pedindo para atualizar",
    "prodata pede atualizacao", "prodata pede atualização", "prodata atualizar",
    "prodata atualizacao", "prodata atualização", "sistema pedindo para atualizar",
    "sistema pede atualizacao", "sistema pede atualização", "sistema atualizar",
    "sistema atualizacao", "sistema atualização", "atualizar o prodata",
    "atualizar o sistema", "atualizacao do prodata", "atualização do prodata",
    "prodata pede para atualizar", "sistema pede para atualizar",
    "preciso atualizar", "preciso fazer atualizacao", "preciso fazer atualização",
    "como atualizo", "como faço para atualizar", "como faco para atualizar",
    "atualizar prodata", "atualizar sistema", "prodata desatualizado",
    "sistema desatualizado", "prodata cache", "sistema cache",
    "prodata esta pedindo", "prodata está pedindo", "sistema esta pedindo",
    "sistema está pedindo", "prodata pedindo", "sistema pedindo",
    "prodata pede", "sistema pede",
]

def ti_gurupi_redirect_reply(cliente: str = "", rascunho: str = "") -> str:
    text = f"{cliente} {rascunho}".lower()
    greeting = _get_greeting_for_response(text)
    if any(trigger in text for trigger in SICAP_TRIGGERS):
        return SICAP_REPLY_TEMPLATE.format(greeting=greeting)
    if any(re.search(pattern, text) for pattern in ACCESS_PATTERNS):
        return ACCESS_REPLY_TEMPLATE.format(greeting=greeting)
    return ""

def cache_reply(text: str) -> str:
    if any(marker in text for marker in CACHE_PATTERNS):
        return CACHE_REPLY_TEMPLATE
    return ""

def manual_keyword_reply(cliente: str, rascunho: str = "", conversation_context: str = "", modo: str = "profissional") -> str:
    query = " ".join(part for part in [cliente, rascunho, conversation_context] if part)
    module = _manual_detect_module(query)
    if module == "gestao pessoal folha":
        return SICAP_REPLY_TEMPLATE.format(greeting=_get_greeting_for_response(query))
    if module in ("compras", "arrecadacoes", "protocolo e atendimento", "almoxarifado e estoque"):
        return ""
    hit = _best_manual_hit(query)
    if not hit:
        return ""
    title = str(hit.get("titulo") or "manual").strip()
    hint = _manual_hint(module or str(hit.get("module") or "outros").strip(), title, str(hit.get("summary") or ""))
    if modo == "curta":
        return hint or f"Consulte o fluxo do manual de {module} para seguir a etapa correta."
    return f"Para esse tema, a orientação prática é: {hint} Se quiser, eu detalho o próximo passo." if hint else "Para esse tema, siga o fluxo do manual como base e responda ao cliente com orientação prática, sem copiar o texto."

# Manual index
def _manual_summary(text: str, limit: int = 420) -> str:
    cleaned = [re.sub(r"\s+", " ", line).strip() for line in (text or "").replace("\r", "\n").splitlines()]
    cleaned = [line for line in cleaned if line][:8]
    return " | ".join(cleaned)[:limit].strip()

def _manual_module(arquivo: str, title: str, text: str) -> str:
    name_blob = _normalize_manual_text(f"{arquivo} {title}")
    body_blob = _normalize_manual_text(text)
    for module, patterns in MANUAL_MODULE_RULES:
        if any(re.search(pattern, name_blob) for pattern in patterns):
            return module
    for module, patterns in MANUAL_MODULE_RULES:
        if any(re.search(pattern, body_blob) for pattern in patterns):
            return module
    return "outros"

def _manual_hint(module: str, title: str, text: str) -> str:
    title_norm = _normalize_manual_text(title)
    blob = _normalize_manual_text(f"{title} {text}")
    hints = {
        "compras": {
            ("requisi", "pedido de compra"): "Na compra, confirme a requisição, a vinculação e os dados do processo antes de seguir.",
            ("licita", "edital", "aviso", "dispensa", "inexigibilidade"): "Na compra, valide a modalidade, a fase do processo e os anexos antes de avançar.",
            ("contrato", "termo de contrato", "aditivo", "apostil"): "No contrato, confira vigência, objeto, valor e os anexos antes da atualização.",
            "fornecedor": "No cadastro de fornecedor, confirme os dados cadastrais e a vinculação correta.",
            "pncp": "No PNCP, valide a fase do procedimento, os dados obrigatórios e os anexos antes de enviar.",
        },
        "arrecadacoes": {"_default": "Em arrecadações, confirme a guia, a receita, a taxa e a baixa antes de concluir."},
        "gestao pessoal folha": {"_default": "Em gestão de pessoal e folha, valide o vínculo, a folha e os limites antes de transmitir."},
        "protocolo e atendimento": {"_default": "No protocolo, confirme assunto, interessado, remessa, despacho e situação do processo."},
        "almoxarifado e estoque": {"_default": "No almoxarifado, confira a entrada, a saída, o estoque e a movimentação antes de concluir."},
    }
    if module in hints:
        module_hints = hints[module]
        for terms, hint in module_hints.items():
            if terms != "_default" and any(term in blob for term in terms):
                return hint
        return module_hints.get("_default", "")
    return ""

def _manual_query_is_specific(query: str) -> bool:
    normalized = _normalize_manual_text(query)
    return normalized and sum(1 for pattern in MANUAL_TRIGGER_PATTERNS if re.search(pattern, normalized)) >= 1

def _manual_detect_module(query: str) -> str:
    normalized = _normalize_manual_text(query)
    if not normalized:
        return ""
    module_keywords = [
        ("gestao pessoal folha", [r"\bsicap\b", r"\bfolha\b", r"\bpessoal\b"]),
        ("arrecadacoes", [r"\barrecad", r"\bduam\b", r"\btaxa\b"]),
        ("protocolo e atendimento", [r"\bprotocolo\b", r"\bglpi\b", r"\bchamado\b"]),
        ("almoxarifado e estoque", [r"\balmoxarif", r"\bestoque\b", r"\bkardex\b"]),
        ("compras", [r"\bpncp\b", r"\bcompra\b", r"\blicita", r"\bcontrato\b"]),
    ]
    for module, patterns in module_keywords:
        if any(re.search(p, normalized) for p in patterns):
            return module
    scores = [(sum(1 for p in patterns if re.search(p, normalized)), module) for module, patterns in MANUAL_MODULE_RULES if module in ALLOWED_MANUAL_MODULES]
    scores = [(s, m) for s, m in scores if s > 0]
    return max(scores, key=lambda x: (-x[0], x[1]))[1] if scores else ""

def _manual_signature() -> tuple[str, ...]:
    return tuple(f"{path.name}:{path.stat().st_mtime_ns}:{path.stat().st_size}" if path.exists() else f"{path.name}:missing" for path in [MANUALS_CORPUS_FILE, ROOT / "memoria" / "manuals_knowledge.md", ROOT / "memoria" / "sicap_ap_knowledge.md"])

def _local_response_signature() -> tuple[str, ...]:
    try:
        stat = LOCAL_RESPONSE_BANK_FILE.stat()
        return (f"{LOCAL_RESPONSE_BANK_FILE.name}:{stat.st_mtime_ns}:{stat.st_size}",)
    except FileNotFoundError:
        return (f"{LOCAL_RESPONSE_BANK_FILE.name}:missing",)

@lru_cache(maxsize=2)
def _load_local_response_bank_cached(signature: tuple[str, ...]) -> dict:
    default_bank = {"entries": []}
    if not LOCAL_RESPONSE_BANK_FILE.exists():
        return default_bank
    try:
        data = json.loads(LOCAL_RESPONSE_BANK_FILE.read_text(encoding="utf-8"))
    except Exception:
        return default_bank
    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        return data
    return default_bank

def load_local_response_bank() -> dict:
    if LOCAL_AI_ONLY_TEST:
        return {"entries": []}
    return _load_local_response_bank_cached(_local_response_signature())

def find_local_response_matches(
    cliente: str = "",
    rascunho: str = "",
    conversation_context: str = "",
    limit: int = 3,
) -> list[dict]:
    query = " ".join(part for part in [cliente, rascunho] if part).strip()
    query = query or _last_customer_line(conversation_context, cliente, rascunho)
    context_blob = " ".join(part for part in [conversation_context, cliente, rascunho] if part).strip()
    if not query and not context_blob:
        return []
    bank = load_local_response_bank().get("entries", [])
    if not bank:
        return []
    scored = []
    for entry in bank:
        if not isinstance(entry, dict):
            continue
        category = str(entry.get("category") or "")
        score = _local_response_score(query, entry) * 4
        allow_context_bonus = category not in {"relationship", "closing", "context_switch"}
        if allow_context_bonus and context_blob and context_blob != query:
            score += _local_response_score(context_blob, entry)
        if category in {"relationship", "closing"} and not _is_lightweight_turn(query):
            continue
        if score > 0:
            scored.append((score, entry))
    if not scored:
        return []
    scored.sort(key=lambda item: (-item[0], -(item[1].get("priority") or 0), str(item[1].get("id") or "")))
    matches = []
    for score, entry in scored[:limit]:
        responses = entry.get("responses") or []
        if isinstance(responses, list) and responses:
            response = str(responses[0]).strip()
        else:
            response = str(entry.get("response") or "").strip()
        if not response:
            continue
        matches.append(
            {
                "id": str(entry.get("id") or ""),
                "category": str(entry.get("category") or ""),
                "priority": int(entry.get("priority") or 0),
                "score": int(score),
                "response": response,
            }
        )
    return matches

def build_local_guidance(
    cliente: str = "",
    rascunho: str = "",
    conversation_context: str = "",
    limit: int = 3,
) -> str:
    if LOCAL_AI_ONLY_TEST:
        return ""
    matches = find_local_response_matches(cliente, rascunho, conversation_context, limit=limit)
    if not matches:
        return ""
    lines = [
        "- Use estas pistas do banco como contexto, não como texto literal."
    ]
    for match in matches:
        if match["category"] in {"relationship", "closing", "context_switch"}:
            continue
        response = match["response"]
        if len(response) > 170:
            response = response[:167].rstrip() + "..."
        lines.append(
            f"- {match['id']} [{match['category']}] (score {match['score']}): {response}"
        )
    return "\n".join(lines) if len(lines) > 1 else ""

def _local_response_score(query: str, entry: dict) -> int:
    normalized_query = _normalize_manual_text(query)
    score = 0
    triggers = entry.get("triggers") or []
    keywords = entry.get("keywords") or []
    context_triggers = entry.get("context_triggers") or []
    for trigger in triggers:
        trigger_norm = _normalize_manual_text(trigger)
        if trigger_norm and trigger_norm in normalized_query:
            score += 4 if len(trigger_norm) >= 12 else 2
    for keyword in keywords:
        keyword_norm = _normalize_manual_text(keyword)
        if keyword_norm and keyword_norm in normalized_query:
            score += 1
    for trigger in context_triggers:
        trigger_norm = _normalize_manual_text(trigger)
        if trigger_norm and trigger_norm in normalized_query:
            score += 1
    return score

def local_response_reply(
    cliente: str = "",
    rascunho: str = "",
    modo: str = "profissional",
    conversation_context: str = "",
) -> str:
    if LOCAL_AI_ONLY_TEST:
        return ""
    query = " ".join(part for part in [cliente, rascunho] if part).strip()
    query = query or _last_customer_line(conversation_context, cliente, rascunho)
    context_blob = " ".join(part for part in [conversation_context, cliente, rascunho] if part).strip()
    if not query and not context_blob:
        return ""
    followup_reply = contextual_followup_reply(query, conversation_context, modo)
    if followup_reply:
        return followup_reply
    current_query = _last_customer_line(conversation_context, cliente, rascunho)
    instant_reply = known_prodata_reply(current_query, rascunho, modo) if current_query else ""
    if instant_reply and _is_lightweight_turn(current_query):
        return instant_reply
    matches = find_local_response_matches(cliente, rascunho, conversation_context, limit=1)
    if not matches:
        return ""
    best = matches[0]
    category = best.get("category") or ""
    threshold = 4 if category in {"relationship", "closing", "context_switch"} else 8
    if int(best.get("score") or 0) < threshold:
        return ""
    response = str(best.get("response") or "").strip()
    if not response:
        return ""
    if "{greeting}" in response:
        response = response.format(greeting=_get_greeting_for_response(query))
    if "{modo}" in response:
        response = response.format(modo=modo)
    return apply_greeting_prefix(greeting_prefix(query), response)

@lru_cache(maxsize=2)
def _build_manual_index_from_corpus(signature: tuple[str, ...]) -> dict:
    items, grouped = [], {}
    if MANUALS_CORPUS_FILE.exists():
        for raw in MANUALS_CORPUS_FILE.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                continue
            arquivo = record.get("arquivo", "")
            titulo = record.get("titulo", "") or Path(arquivo).stem
            texto = record.get("texto", "") or ""
            module = _manual_module(arquivo, titulo, texto)
            if module not in ALLOWED_MANUAL_MODULES:
                continue
            entry = {"arquivo": arquivo, "titulo": titulo, "module": module, "summary": _manual_summary(texto), "hint": _manual_hint(module, titulo, texto), "keywords": sorted(_manual_tokens(f"{arquivo} {titulo} {texto}"))[:60]}
            items.append(entry)
            grouped.setdefault(module, []).append(entry)
    return {"source_signature": list(signature), "items": items, "by_module": grouped}

@lru_cache(maxsize=2)
def _load_manual_index_cached(signature: tuple[str, ...]) -> dict:
    if MANUALS_INDEX_FILE.exists():
        try:
            data = json.loads(MANUALS_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("source_signature") == list(signature) and "items" in data:
                return data
        except Exception:
            pass
    return _build_manual_index_from_corpus(signature)

def load_manual_index() -> dict:
    return _load_manual_index_cached(_manual_signature())

def build_manual_context(query: str, limit: int = MAX_MANUAL_HITS) -> str:
    index = load_manual_index()
    items = index.get("items", [])
    query_words = _manual_tokens(query)
    if not items or not query_words:
        return ""
    target_module = _manual_detect_module(query)
    if target_module not in ALLOWED_MANUAL_MODULES:
        return ""
    scored = []
    for entry in items:
        if str(entry.get("module") or "").strip() != target_module:
            continue
        overlap = len(query_words & set(entry.get("keywords") or []))
        title_overlap = len(query_words & _manual_tokens(entry.get("titulo", "")))
        module_overlap = len(query_words & _manual_tokens(entry.get("module", "")))
        score = overlap + (title_overlap * 2) + (module_overlap * 2)
        if score > 0:
            scored.append((score, entry))
    if not scored:
        return ""
    scored.sort(key=lambda item: (-item[0], item[1].get("module", ""), item[1].get("titulo", "")))
    return "\n".join(f"- {e.get('module', 'outros').title()}: {e.get('titulo', '')} -> {_manual_hint(str(e.get('module') or 'outros'), str(e.get('titulo') or 'manual'), str(e.get('summary') or ''))}" for _, e in scored[:limit])

def _best_manual_hit(query: str) -> dict | None:
    index = load_manual_index()
    items = index.get("items", [])
    query_words = _manual_tokens(query)
    if not items or not query_words or not _manual_query_is_specific(query):
        return None
    target_module = _manual_detect_module(query)
    if target_module not in ALLOWED_MANUAL_MODULES:
        return None
    scored = []
    for entry in items:
        if str(entry.get("module") or "").strip() != target_module:
            continue
        overlap = len(query_words & set(entry.get("keywords") or []))
        title_overlap = len(query_words & _manual_tokens(entry.get("titulo", "")))
        module_overlap = len(query_words & _manual_tokens(entry.get("module", "")))
        score = overlap + (title_overlap * 2) + (module_overlap * 2)
        if score > 0:
            scored.append((score, entry))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1].get("module", ""), item[1].get("titulo", "")))
    best_score, best_entry = scored[0]
    return best_entry if best_score >= 4 else None

# Context building
def _build_context_cached(signature: tuple[str, ...]) -> str:
    parts = []
    for relative in MEMORY_FILES:
        path = ROOT / relative
        content = _read_tail_lines(path, MAX_LEARNED_LINES) if "aprendizados" in relative else read_text(path)
        if content:
            parts.append(f"## {relative}\n{content}")
    examples = build_recent_examples()
    if examples:
        parts.append(f"## dados/atendimentos.jsonl\n{examples}")
    return "\n\n".join(parts)

_CONTEXT_CACHE: tuple[float, str] = (0.0, "")
_CONTEXT_CACHE_TTL = 3.0

def build_context() -> str:
    global _CONTEXT_CACHE
    now = time.monotonic()
    if _CONTEXT_CACHE[0] and (now - _CONTEXT_CACHE[0]) < _CONTEXT_CACHE_TTL:
        return _CONTEXT_CACHE[1]
    signature = []
    for relative in MEMORY_FILES:
        path = ROOT / relative
        try:
            stat = path.stat()
            signature.append(f"{relative}:{stat.st_mtime_ns}:{stat.st_size}")
        except FileNotFoundError:
            signature.append(f"{relative}:missing")
    history_path = ROOT / "dados" / "atendimentos.jsonl"
    try:
        stat = history_path.stat()
        signature.append(f"history:{stat.st_mtime_ns}:{stat.st_size}")
    except FileNotFoundError:
        signature.append("history:missing")
    result = _build_context_cached(tuple(signature))
    _CONTEXT_CACHE = (now, result)
    return result

def _build_compact_context_cached(signature: tuple[str, ...]) -> str:
    parts = []
    for relative in COMPACT_MEMORY_FILES:
        content = read_text(ROOT / relative)
        if content:
            if len(content) > 1200:
                content = content[:1200].rstrip() + "\n...[resumido para modo rapido]"
            parts.append(f"## {relative}\n{content}")
    learned = _read_tail_lines(ROOT / "memoria" / "aprendizados.md", 28)
    if learned:
        if len(learned) > 1200:
            learned = learned[-1200:].lstrip()
        parts.append(f"## memoria/aprendizados.md\n{learned}")
    return "\n\n".join(parts)

_COMPACT_CONTEXT_CACHE: tuple[float, str] = (0.0, "")

def build_compact_context() -> str:
    global _COMPACT_CONTEXT_CACHE
    now = time.monotonic()
    if _COMPACT_CONTEXT_CACHE[0] and (now - _COMPACT_CONTEXT_CACHE[0]) < _CONTEXT_CACHE_TTL:
        return _COMPACT_CONTEXT_CACHE[1]
    signature = [f"{f}:{(ROOT / f).stat().st_mtime_ns}:{(ROOT / f).stat().st_size}" if (ROOT / f).exists() else f"{f}:missing" for f in COMPACT_MEMORY_FILES + ["memoria/aprendizados.md"]]
    result = _build_compact_context_cached(tuple(signature))
    _COMPACT_CONTEXT_CACHE = (now, result)
    return result

def build_recent_examples(limit: int = MAX_HISTORY_EXAMPLES) -> str:
    history_path = ROOT / "dados" / "atendimentos.jsonl"
    try:
        records = history_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ""
    examples, seen = [], set()
    for raw in reversed(records[-120:]):
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        question = " ".join((record.get("cliente", "") or "").split())
        answer = " ".join((record.get("resposta_aprovada", "") or "").split())
        if not is_high_quality_pair(question, answer):
            continue
        key = f"{question} -> {answer}"
        if key in seen:
            continue
        seen.add(key)
        examples.append(f"- Cliente: {question}\n  Resposta: {answer}")
        if len(examples) >= limit:
            break
    return "\n".join(examples)

def build_learning_skills(limit: int = 6) -> str:
    history_path = ROOT / "dados" / "atendimentos.jsonl"
    try:
        records = history_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ""
    skills, seen, count = [], set(), 0
    for raw in reversed(records[-80:]):
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        question = " ".join((record.get("cliente", "") or "").split())
        answer = " ".join((record.get("resposta_aprovada", "") or "").split())
        if not is_high_quality_pair(question, answer):
            continue
        key = f"{question} -> {answer}"
        if key in seen:
            continue
        seen.add(key)
        q_words = words(question)
        if len(q_words) < 3:
            continue
        q_lower = question.lower()
        if _detect_greeting(question):
            skills.append("- Ao receber saudação, responda com a mesma saudação e siga o assunto.")
        elif any(t in q_lower for t in ["sicap", "folha", "pessoal"]):
            skills.append("- Em SICAP/AP, mantenha a resposta curta, orientativa e sem prometer ajuste de arquivo.")
        elif any(t in q_lower for t in ["requisi", "compr", "empenho", "contrato"]):
            skills.append("- Em compras, responda com foco na etapa atual, na vinculação e nos campos obrigatórios.")
        elif any(t in q_lower for t in ["glpi", "chamado", "protocolo"]):
            skills.append("- Em protocolo/GLPI, oriente abertura ou acompanhamento de chamado com resumo objetivo.")
        elif any(t in q_lower for t in ["kardex", "estoque", "almoxarif"]):
            skills.append("- Em almoxarifado, valide entrada, saída, saldo e inventário antes de concluir.")
        else:
            skills.append(f"- Quando o cliente pedir algo direto, responda com a orientação prática aprovada: {answer[:120]}")
        if len(skills) >= limit:
            break
    return "\n".join(skills)

def build_prodata_prompt(
    cliente: str,
    rascunho: str,
    modo: str,
    context: str | None = None,
    conversation_context: str | None = None,
    fast: bool = False,
    local_guidance: str | None = None,
    visual_context: str | None = None,
) -> str:
    memory = context if context is not None else (build_compact_context() if fast else build_context())
    conversation_context = conversation_context or ""
    cliente = cliente or extract_last_customer_message(conversation_context)
    query_parts = [cliente, rascunho, conversation_context]
    query_text = " ".join(part for part in query_parts if part)
    manual_context = build_manual_context(query_text, limit=1 if fast else MAX_MANUAL_HITS)
    learning_skills = "" if fast else build_learning_skills()
    local_guidance = (local_guidance or "").strip()
    visual_context = (visual_context or "").strip()
    conversation_block = f"\n\nContexto da conversa:\n{conversation_context}" if conversation_context else ""
    manual_block = f"\n\nConhecimento manual relevante:\n{manual_context}" if manual_context else ""
    learning_block = f"\n\nSkills aprendidas recentemente:\n{learning_skills}" if learning_skills else ""
    guidance_block = f"\n\nPistas do banco local:\n{local_guidance}" if local_guidance else ""
    visual_block = f"\n\nContexto visual:\n{visual_context}" if visual_context else ""
    return f"""
Voce e um copiloto local de atendimento profissional para suporte ao sistema Prodata em Gurupi-GO.
Sua tarefa e gerar a melhor resposta possivel, com liberdade, naturalidade e criterio proprio, antes do atendente enviar.

Regras gerais:
- Responda somente com a mensagem final para o cliente.
- Nao invente procedimentos, valores, prazos, links ou garantias.
- Se faltar informacao tecnica, peca print, mensagem exata do erro, CNPJ/empresa ou etapa onde ocorreu.
- Quando o cliente falar em certificado, entenda como certificado digital A1/A3 usado para emissao fiscal.
- Nao confunda certificado digital com QR Code, e-mail, login ou validacao de imagem.
- Use o conhecimento dos manuais apenas como referencia. Reescreva com linguagem propria e nunca copie trechos literais dos manuais.
- Se a mensagem comecar com saudacao, preserve a saudacao na resposta.
- Use os exemplos aprovados como habilidade aprendida, nao como modelo literal.
- Priorize raciocinio por contexto, intencao e etapa atual. Se houver duvida, faca uma pergunta objetiva e curta.
- Prefira respostas livres, humanas e especificas ao caso. Evite parecer um roteirista de resposta pronta.
- Use portugues do Brasil, claro, educado e direto.
- Preserve um tom humano, sem parecer robo.
- Nao diga que e uma IA.
- Nao envie textos longos demais para WhatsApp; use o minimo necessario para resolver, normalmente 1 a 4 frases, mas sem engessar a resposta.
- Mode solicitado: {modo}.
- Se faltar contexto suficiente, peca uma informacao objetiva antes de responder.

Regras de acompanhamento de conversa (OBRIGATORIO):
- Acompanhe TODO o raciocinio do cliente durante a conversa, mesmo que ele troque de assunto.
- Quando o cliente mudar de assunto, siga o novo contexto IMEDIATAMENTE.
- Memorize TODOS os assuntos anteriores discutidos na conversa.
- Se o cliente retornar a uma demanda ja discutida, recupere o contexto automaticamente.
- NUNCA ignore contextos anteriores mesmo que o cliente mude de assunto temporariamente.
- Exemplo: se o cliente falou de "requisicao de compra" e depois trocou para "chamado GLPI", e depois voltou a falar de "requisicao", voce deve lembrar do contexto inicial e retomar de onde parou.
- Mantenha registro mental de todos os assuntos abordados para poder retomar quando necessario.
- Se o cliente trocar de assunto, siga o novo assunto sem insistir no anterior.

Memoria local e exemplos aprovados:
{memory}
{conversation_block}
{manual_block}
{learning_block}
{guidance_block}
{visual_block}

Mensagem do cliente:
{cliente or "(nao informada)"}

Rascunho do atendente:
{rascunho or "(nao informado)"}

Mensagem final:
""".strip()

def learned_reply(context: str) -> str:
    lines = [line.strip() for line in context.splitlines() if line.strip()]
    customer_lines = [re.sub(r"^cliente:\s*", "", line, flags=re.I).strip() for line in lines if line.lower().startswith("cliente:")]
    if not customer_lines:
        return ""
    current = customer_lines[-1]
    current_words = words(current)
    if len(current_words) < 5:
        return ""
    best_score, best_answer = 0.0, ""
    index = _load_knowledge_index()
    indexed_entries = [entry for entry in index.get("entries", []) if isinstance(entry, dict)]
    if indexed_entries:
        for entry in indexed_entries:
            if float(entry.get("confianca") or 0) < LEARNING_MIN_CONFIDENCE:
                continue
            question = str(entry.get("pergunta") or "")
            answer = str(entry.get("resposta") or "")
            if not is_high_quality_pair(question, answer):
                continue
            question_words = words(question)
            if not question_words:
                continue
            overlap = len(current_words & question_words)
            score = (overlap / max(len(current_words), 1)) + (float(entry.get("confianca") or 0) * 0.12)
            if overlap >= 4 and score > best_score:
                best_score, best_answer = score, answer
        return best_answer.strip() if best_score >= 0.78 and len(best_answer.strip()) >= 8 else ""
    history_path = ROOT / "dados" / "atendimentos.jsonl"
    try:
        records = history_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ""
    for raw in records[-300:]:
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        question, answer = record.get("cliente", ""), record.get("resposta_aprovada", "")
        if not is_high_quality_pair(question, answer):
            continue
        question_words = words(question)
        if not question_words:
            continue
        overlap = len(current_words & question_words)
        score = overlap / max(len(current_words), 1)
        if overlap >= 4 and score > best_score:
            best_score, best_answer = score, answer
    return best_answer.strip() if best_score >= 0.72 and len(best_answer.strip()) >= 8 else ""

def known_prodata_reply(cliente: str, rascunho: str, modo: str) -> str:
    current_line = _last_meaningful_line(cliente, rascunho)
    text = current_line.lower()
    greet = greeting_reply(current_line)
    if greet:
        return greet
    prefix = greeting_prefix(current_line)
    sicap_reply = ti_gurupi_redirect_reply(current_line, "")
    if sicap_reply:
        return apply_greeting_prefix(prefix, sicap_reply)
    cache_resp = cache_reply(text)
    if cache_resp:
        return apply_greeting_prefix(prefix, cache_resp)
    asks_help = any(marker in text for marker in ["pode me ajudar", "me ajuda", "preciso de ajuda", "você pode me ajudar", "voce pode me ajudar"])
    if asks_help:
        return apply_greeting_prefix(prefix, "Claro. Me envie a mensagem do cliente ou um print da tela para eu verificar com mais precisão.")
    last_line = text
    last_from_me = False
    has_cert = bool(re.search(r"\bcertificado\b|\bcertificado digital\b|\ba1\b|\ba3\b", text))
    has_invoice = "nota" in text or "nf" in text or "nfe" in text or "nf-e" in text
    has_same_error = "mesmo erro" in text or "mesma mensagem" in text or "mesmo problema" in text
    has_checking = "verificando" in text or "estamos verificando" in text or "vou verificar" in text
    has_negative_quota = "cota negativa" in text or "cotas negativas" in text
    has_budget_commitment = "empenhar" in text or "empenho" in text or "orçamento" in text or "orcamento" in text
    has_ticket = "chamado" in text or "abrir chamado" in text or "abre chamado" in text
    asks_call = "me ligar" in text or "pode ligar" in text or "puder me ligar" in text or "posso te ligar" in text
    did_not_understand = "não entendi" in text or "nao entendi" in text or "não compreendi" in text or "nao compreendi" in text
    has_bank_change = "banco" in text and any(t in text for t in ["alteração", "alteracoes", "alterações", "corrigir", "quebrou", "manual"])
    has_manual_fix = "corrigir manualmente" in text or "manualmente" in text
    has_anydesk = "anydesk" in text or "any desk" in text
    has_remote_code = bool(re.search(r"\b\d{3}\s+\d{3}\s+\d{3}\b", text))
    has_value_change = "alterar o valor" in text or "não consigo alterar" in text or "nao consigo alterar" in text or "requisição" in text or "requisicao" in text
    update_worked = ("atualização" in text or "atualizacao" in text) and ("deu certo" in text or "melhorou" in text)
    asks_usb_test = ("usb vga" in text or "vga" in text) and ("tem como" in text or "posso" in text or "testa" in text or "testar" in text)
    asks_news = "alguma novidade" in text or "tem novidade" in text or "algum retorno" in text or "tem retorno" in text or "conseguiu ver" in text or "conseguiu verificar" in text
    says_no_news = "por enquanto nada" in text or "ainda nada" in text or "sem novidade" in text or "sem retorno" in text
    closes_conversation = any(marker in last_line for marker in ["obrigad", "ta bom", "tá bom", "ok", "beleza", "valeu", "certo", "perfeito", "show", "blz"])
    customer_will_check = any(marker in last_line for marker in ["vou descobrir", "vou verificar", "vou olhar", "vou conferir", "vou testar", "vamos tentar"])
    asks_vacation = "ferias" in text or "férias" in text
    if last_from_me:
        return ""
    if any(marker in last_line for marker in ["obrigad", "obg", "valeu"]):
        return "Disponha! Qualquer coisa, é só me chamar."
    if closes_conversation and customer_will_check:
        return "Perfeito. Qualquer coisa, fico à disposição."
    if closes_conversation and len(last_line) <= 80:
        return "Perfeito. Qualquer coisa, fico à disposição."
    if update_worked:
        return "Perfeito. Então vamos manter assim por enquanto. Se aparecer qualquer instabilidade, me avise por aqui."
    if asks_usb_test:
        return "Pode testar sim. Se não reconhecer de primeira, me avise que eu verifico a configuração com você."
    if (has_anydesk or has_remote_code) and has_value_change:
        return "Certo, vou acessar pelo AnyDesk e verificar essa questão dos valores das requisições. Deixe o Prodata aberto na tela da cotação, por favor."
    if has_anydesk or has_remote_code:
        return "Certo, vou acessar pelo AnyDesk para verificar."
    learned = learned_reply(current_line)
    if learned:
        return apply_greeting_prefix(prefix, learned)
    manual = manual_keyword_reply(current_line, "", "", modo)
    if manual:
        return apply_greeting_prefix(prefix, manual)
    if has_cert and has_invoice:
        return apply_greeting_prefix(prefix, "Verifique se o certificado digital esta conectado/instalado corretamente e se esta dentro da validade. Depois feche e abra o Prodata e tente emitir a nota novamente. Se continuar, me envie um print da mensagem exata do erro." if modo == "curta" else "Entendi. Verifique, por favor, se o certificado digital esta conectado ou instalado corretamente e se ainda está dentro da validade. Depois feche e abra novamente o Prodata e tente emitir a nota outra vez. Se a mensagem continuar aparecendo, me envie um print do erro para eu verificar com mais precisão.")
    if has_same_error:
        return apply_greeting_prefix(prefix, "Entendi. Me envie, por favor, um print da mensagem de erro e informe em qual tela ou etapa ela aparece. Vou comparar com o caso anterior e verificar a melhor orientação para corrigirmos.")
    if has_negative_quota and has_budget_commitment:
        return apply_greeting_prefix(prefix, "Entendi. Nesse caso, parece estar relacionado à cota dos meses usados no empenho. Verifique as competências envolvidas, principalmente agosto e setembro, e confirme se a cota está negativa nelas. Se continuar, me envie um print da tela da cota negativa para eu analisar melhor.")
    if has_bank_change and has_manual_fix:
        return apply_greeting_prefix(prefix, "Entendi. Como houve alteração direta no banco e isso afetou o registro, o ideal é corrigir esse caso manualmente com cuidado. Me envie o print da tela e os dados do cadastro afetado para eu conferir antes de orientar a correção.")
    if has_bank_change:
        return apply_greeting_prefix(prefix, "Entendi. Parece estar relacionado a uma alteração feita diretamente no banco. Me envie o print da tela e os dados do registro afetado para eu verificar a correção mais segura.")
    if has_negative_quota:
        return apply_greeting_prefix(prefix, "Entendi. Me envie um print da tela onde aparece a cota negativa e informe em qual etapa isso ocorre. Com isso consigo verificar a orientação correta.")
    if has_ticket and asks_call and did_not_understand:
        return apply_greeting_prefix(prefix, "Claro, posso te ligar para entender melhor. Se puder, abra o chamado com um resumo do que aconteceu e me envie o número, que eu verifico com mais precisão.")
    if has_ticket and did_not_understand:
        return apply_greeting_prefix(prefix, "Sem problema. Abra o chamado explicando o que aconteceu e, se puder, inclua prints ou a mensagem que aparece. Assim consigo analisar melhor e te orientar corretamente.")
    if asks_call and did_not_understand:
        return apply_greeting_prefix(prefix, "Claro, posso te ligar para entender melhor o caso. Me confirme um horário bom para eu falar com você.")
    if asks_call:
        return apply_greeting_prefix(prefix, "Só um momento que já verifico a melhor forma de te ajudar.")
    if asks_news and says_no_news:
        return apply_greeting_prefix(prefix, "Bom dia. Por enquanto ainda nao tenho uma novidade sobre esse caso, mas sigo acompanhando. Assim que eu tiver um retorno ou uma orientacao mais concreta, aviso voce por aqui.")
    if asks_news:
        return apply_greeting_prefix(prefix, "Bom dia. Vou verificar o andamento desse caso e te retorno por aqui assim que tiver uma posicao.")
    if asks_vacation:
        return apply_greeting_prefix(prefix, "Nao, ele nao esta de ferias no momento. Pelo que foi informado, sera somente no dia 14.")
    if has_checking:
        return apply_greeting_prefix(prefix, "Certo, vou verificar esse caso e te retorno com a orientação. Se puder, me envie também um print da tela com a mensagem para eu analisar com mais precisão.")
    if "ahh sim" in last_line or "ah sim" in last_line or "entendi" == last_line:
        return apply_greeting_prefix(prefix, "Isso mesmo. Qualquer coisa, fico à disposição.")
    if closes_conversation:
        return apply_greeting_prefix(prefix, "Certo. Qualquer coisa, fico à disposição.")
    return ""

def contextual_fallback(cliente: str = "", rascunho: str = "", modo: str = "profissional") -> str:
    text = f"{cliente} {rascunho}".lower()
    if any(word in text for word in ["erro", "problema", "requisição", "requisicao", "empenho", "fonte", "cadastro"]):
        return "Entendi. Me envie um print da tela e informe em qual etapa isso aparece para eu verificar com mais precisão."
    return "Certo. Se precisar, me envie um print para eu conferir." if modo == "curta" else "Certo. Qualquer coisa, fico à disposição."

def _normalize_learning_text(text: str) -> str:
    text = _normalize_manual_text(text)
    text = re.sub(r"https?://\S+", " URL ", text)
    text = re.sub(r"\b\d{1,2}:\d{2}\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

def _learning_signature(question: str, answer: str) -> str:
    return f"{_normalize_learning_text(question)} -> {_normalize_learning_text(answer)}"

def _is_url_noise(text: str) -> bool:
    compact = re.sub(r"\s+", "", text or "").lower()
    if not compact:
        return False
    url_count = len(re.findall(r"https?://|[\w.-]+\.(?:com|br|app|inf|org|net)", compact))
    if url_count >= 2:
        return True
    return bool(url_count and len(re.sub(r"https?://|[\w./:#?=&%-]|com|br|app|inf|org|net", "", compact)) < 8)

def _is_garbage_text(text: str) -> bool:
    normalized = _normalize_learning_text(text)
    if not normalized:
        return True
    if any(marker in normalized for marker in ["media-cancel", "mensagem apagada", "clique para mostrar", "portal conecta prodata"]):
        return True
    if _is_url_noise(text):
        return True
    words_found = re.findall(r"[a-záàâãéèêíïóôõöúçñ]{3,}", normalized)
    if len(words_found) >= 12:
        common_pt = {
            "que", "para", "com", "uma", "meu", "minha", "não", "nao", "estou", "preciso", "sistema",
            "prodata", "erro", "acesso", "senha", "usuario", "usuário", "chamado", "compra", "empenho",
            "requisição", "requisicao", "cliente", "print", "tela", "verificar", "bom", "dia",
        }
        hits = sum(1 for word in words_found if word in common_pt or any(ch in word for ch in "áàâãéèêíïóôõöúçñ"))
        avg_len = sum(len(word) for word in words_found) / max(len(words_found), 1)
        if hits <= 1 and avg_len > 5.8:
            return True
    if re.search(r"\bquick general vicious curious limb injury enemy reject\b", normalized):
        return True
    return False

def _has_repeated_halves(text: str) -> bool:
    normalized = _normalize_learning_text(text)
    words_found = normalized.split()
    if len(words_found) < 12 or len(words_found) % 2:
        return False
    half = len(words_found) // 2
    return words_found[:half] == words_found[half:]

def classify_learning(question: str, answer: str) -> str:
    text = _normalize_learning_text(f"{question} {answer}")
    scores = []
    for category, keywords in KNOWLEDGE_CATEGORIES.items():
        score = sum(1 for keyword in keywords if _normalize_learning_text(keyword) in text)
        if score:
            scores.append((score, category))
    if not scores:
        return "geral"
    return max(scores, key=lambda item: (item[0], item[1]))[1]

def calculate_learning_confidence(question: str, answer: str, category: str, uses: int = 1) -> float:
    confidence = 0.46
    if category != "geral":
        confidence += 0.16
    answer_words = len(re.findall(r"\w+", answer or ""))
    question_words = len(re.findall(r"\w+", question or ""))
    if answer_words >= 8:
        confidence += 0.10
    if question_words >= 4:
        confidence += 0.06
    if uses >= 2:
        confidence += min(0.16, 0.04 * uses)
    if _is_url_noise(question) or _is_url_noise(answer):
        confidence -= 0.35
    if any(re.search(pattern, _normalize_manual_text(question)) for pattern in SOCIAL_LEARNING_PATTERNS):
        confidence -= 0.24
    return round(max(0.0, min(confidence, 1.0)), 3)

def is_high_quality_pair(question: str, answer: str) -> bool:
    question = " ".join((question or "").split())
    answer = " ".join((answer or "").split())
    if not is_valid_pair(question, answer):
        return False
    if _is_garbage_text(question) or _is_garbage_text(answer):
        return False
    q_norm = _normalize_manual_text(question)
    a_norm = _normalize_manual_text(answer)
    q_plain = re.sub(r"[^a-z0-9áàâãéèêíïóôõöúçñ ]+", " ", q_norm)
    a_plain = re.sub(r"[^a-z0-9áàâãéèêíïóôõöúçñ ]+", " ", a_norm)
    q_plain = re.sub(r"\s+", " ", q_plain).strip()
    a_plain = re.sub(r"\s+", " ", a_plain).strip()
    if any(re.search(pattern, q_norm) or re.search(pattern, q_plain) for pattern in SOCIAL_LEARNING_PATTERNS):
        return False
    if any(re.search(pattern, q_norm) or re.search(pattern, q_plain) for pattern in LOW_VALUE_QUESTION_PATTERNS):
        return False
    if any(re.search(pattern, a_norm) or re.search(pattern, a_plain) for pattern in LOW_VALUE_ANSWER_PATTERNS):
        return False
    if _has_repeated_halves(answer):
        return False
    access_reply = ti_gurupi_redirect_reply(question)
    if access_reply and "3301-4304" not in answer:
        return False
    cache_direct = cache_reply(q_norm)
    if cache_direct and "Ctrl + F5" not in answer and "ctrl + f5" not in a_norm:
        return False
    if any(trigger in q_norm for trigger in SICAP_TRIGGERS) and "tceto.tc.br" not in answer and "sicap" not in a_norm:
        return False
    if len(re.findall(r"\w+", answer)) < 4:
        return False
    if q_norm == a_norm:
        return False
    return True

def _load_knowledge_index() -> dict[str, Any]:
    if not KNOWLEDGE_INDEX_FILE.exists():
        return {"version": 1, "categorias": {}, "entries": [], "metricas": {}}
    try:
        data = json.loads(KNOWLEDGE_INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 1, "categorias": {}, "entries": [], "metricas": {}}
    if not isinstance(data, dict):
        return {"version": 1, "categorias": {}, "entries": [], "metricas": {}}
    data.setdefault("version", 1)
    data.setdefault("categorias", {})
    data.setdefault("entries", [])
    data.setdefault("metricas", {})
    return data

def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)

def _rebuild_knowledge_metrics(index: dict[str, Any], total_seen: int = 0, rejected: int = 0) -> dict[str, Any]:
    entries = [entry for entry in index.get("entries", []) if isinstance(entry, dict)]
    categories: dict[str, dict[str, Any]] = {}
    for entry in entries:
        category = str(entry.get("categoria") or "geral")
        bucket = categories.setdefault(category, {"count": 0, "ultima_atualizacao": "", "exemplos": []})
        bucket["count"] += 1
        updated = str(entry.get("ultima_atualizacao") or entry.get("data") or "")
        if updated > bucket["ultima_atualizacao"]:
            bucket["ultima_atualizacao"] = updated
        if len(bucket["exemplos"]) < 5:
            bucket["exemplos"].append({
                "pergunta": entry.get("pergunta", ""),
                "resposta": entry.get("resposta", ""),
                "confianca": entry.get("confianca", 0),
                "usos": entry.get("usos", 1),
            })
    valid = len(entries)
    total = total_seen or int(index.get("metricas", {}).get("total_aprendizados") or valid)
    index["categorias"] = categories
    index["metricas"] = {
        "total_aprendizados": total,
        "aprendizados_validos": valid,
        "rejeitados": rejected,
        "taxa_qualidade": round(valid / total, 3) if total else 0,
        "ultima_atualizacao": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    return index

def update_knowledge_index(record: dict[str, Any]) -> dict[str, Any]:
    index = _load_knowledge_index()
    signature = str(record.get("assinatura") or _learning_signature(record.get("cliente", ""), record.get("resposta_aprovada", "")))
    entries = [entry for entry in index.get("entries", []) if isinstance(entry, dict)]
    for entry in entries:
        if entry.get("assinatura") != signature:
            continue
        entry["usos"] = int(entry.get("usos") or 1) + 1
        entry["ultima_atualizacao"] = record.get("data")
        entry["confianca"] = calculate_learning_confidence(entry.get("pergunta", ""), entry.get("resposta", ""), entry.get("categoria", "geral"), int(entry.get("usos") or 1))
        index["entries"] = entries
        _rebuild_knowledge_metrics(index)
        _write_json(KNOWLEDGE_INDEX_FILE, index)
        return entry
    category = str(record.get("categoria") or classify_learning(record.get("cliente", ""), record.get("resposta_aprovada", "")))
    entry = {
        "assinatura": signature,
        "data": record.get("data"),
        "ultima_atualizacao": record.get("data"),
        "pergunta": record.get("cliente", ""),
        "resposta": record.get("resposta_aprovada", ""),
        "categoria": category,
        "confianca": calculate_learning_confidence(record.get("cliente", ""), record.get("resposta_aprovada", ""), category, 1),
        "usos": 1,
        "aprovado": True,
    }
    entries.append(entry)
    index["entries"] = sorted(entries, key=lambda item: (-float(item.get("confianca") or 0), -int(item.get("usos") or 0), str(item.get("categoria") or "")))[:1200]
    _rebuild_knowledge_metrics(index)
    _write_json(KNOWLEDGE_INDEX_FILE, index)
    return entry

def _record_learning_reject(cliente: str, resposta: str, motivo: str) -> None:
    QUALITY_REJECTS_FILE.parent.mkdir(exist_ok=True)
    record = {
        "data": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "motivo": motivo,
        "cliente": cliente,
        "resposta": resposta,
    }
    with QUALITY_REJECTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")

def save_learning(cliente: str, rascunho: str, resposta: str, aprendizado: str) -> None:
    if not is_high_quality_pair(cliente, resposta):
        _record_learning_reject(cliente, resposta, "baixa_qualidade")
        return
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    records_dir = ROOT / "dados"
    records_dir.mkdir(exist_ok=True)
    category = classify_learning(cliente, resposta)
    signature = _learning_signature(cliente, resposta)
    confidence = calculate_learning_confidence(cliente, resposta, category, 1)
    if confidence < LEARNING_MIN_CONFIDENCE:
        _record_learning_reject(cliente, resposta, "baixa_confianca")
        return
    record = {
        "data": now,
        "cliente": cliente,
        "rascunho": rascunho,
        "resposta_aprovada": resposta,
        "aprendizado": aprendizado,
        "categoria": category,
        "confianca": confidence,
        "assinatura": signature,
    }
    index_entry = update_knowledge_index(record)
    if int(index_entry.get("usos") or 1) > 1:
        return
    with (records_dir / "atendimentos.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    learned_path = ROOT / "memoria" / "aprendizados.md"
    learned_path.parent.mkdir(exist_ok=True)
    lines = [f"\n## {now}\n"]
    if aprendizado:
        lines.append(f"- Regra/observacao: {aprendizado}\n")
    if cliente:
        lines.append(f"- Cliente perguntou: {cliente}\n")
    if resposta:
        lines.append(f"- Resposta aprovada: {resposta}\n")
    with learned_path.open("a", encoding="utf-8") as fh:
        fh.writelines(lines)

def _derive_learning_rules(cliente: str, rascunho: str, resposta: str, aprendizado: str) -> list[str]:
    text = " ".join(part for part in [cliente, rascunho, resposta, aprendizado] if part).lower()
    rules = []
    def add(rule: str) -> None:
        if rule not in rules:
            rules.append(rule)
    if any(term in text for term in ["erro", "problema", "falha", "mensagem", "não consigo", "nao consigo"]):
        add("Quando houver erro ou problema, pedir print da tela e etapa exata antes de concluir.")
    if any(term in text for term in ["anydesk", "acesso remoto", "me passa anydesk", "código", "codigo"]):
        add("Quando for preciso acesso remoto, pedir AnyDesk ou código de acesso antes de orientar.")
    if any(term in text for term in ["chamado", "glpi", "protocolo", "ticket"]):
        add("Quando faltar contexto técnico, orientar abertura ou acompanhamento de chamado com resumo objetivo.")
    if any(term in text for term in ["bom dia", "boa tarde", "boa noite", "oi", "olá", "ola"]):
        add("Ao receber saudação, responder com saudação equivalente e seguir o assunto principal.")
    if any(term in text for term in ["retorno", "novidade", "andamento", "status", "previsão", "previsao"]):
        add("Quando perguntarem por retorno ou novidade, responder de forma curta com o status atual e próximo passo.")
    if any(term in text for term in ["cota negativa", "empenho", "orçamento", "orcamento"]):
        add("Em empenho e orçamento, validar cota negativa, competências envolvidas e tela exata antes de concluir.")
    if any(term in text for term in ["certificado", "a1", "a3", "nota fiscal", "nf", "nfe"]):
        add("Em certificado digital e emissão fiscal, validar conexão, validade e mensagem do erro antes de orientar.")
    if any(term in text for term in ["ajuda", "me ajuda", "pode me ajudar", "preciso de ajuda"]):
        add("Quando o cliente pedir ajuda de forma genérica, solicitar a mensagem ou print da tela.")
    if aprendizado:
        add(aprendizado)
    return rules

# HTTP Handler
def resolve_model() -> str:
    model = read_text(MODEL_FILE) or DEFAULT_MODEL
    return MODEL_ALIASES.get(model, model)

def resolve_deepseek_model() -> str:
    return os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash").strip() or "deepseek-v4-flash"

def deepseek_generate(prompt: str, model: str | None = None, timeout: float = DEEPSEEK_TIMEOUT_SECONDS) -> str:
    api_key = read_deepseek_api_key()
    if not api_key:
        raise RuntimeError("Nao encontrei a chave do DeepSeek.")
    model = model or resolve_deepseek_model()
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip().rstrip("/")
    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Voce e um copiloto de suporte do SIG Prodata. "
                    "Responda com liberdade, contexto e objetividade, sem copiar o banco local literalmente."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.35,
        "max_tokens": 260,
        "stream": False,
    }
    if "deepseek-v4" in model:
        payload["thinking"] = {"type": "disabled"}
        payload["reasoning_effort"] = "low"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError("Nao consegui falar com o DeepSeek.") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Resposta invalida do DeepSeek.") from exc
    choices = payload.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return str(message.get("content") or "").strip()

def qwen_generate(prompt: str, model: str | None = None, timeout: float = QWEN_TIMEOUT_SECONDS) -> str:
    api_key = read_qwen_api_key()
    if not api_key:
        raise RuntimeError("Nao encontrei a chave da Qwen.")
    model = model or resolve_qwen_model()
    base_url = os.environ.get("QWEN_BASE_URL", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").strip().rstrip("/")
    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Voce e um colega de suporte do SIG Prodata. "
                    "Interprete texto com liberdade, contexto forte e objetividade, sem cair em respostas genericas. "
                    "Quando a conversa estiver aberta ou a solicitação vier incompleta, nao reduza demais a resposta: entregue uma orientacao um pouco mais cheia e humana. "
                    "Fale de forma natural, humana e direta, como alguem da equipe orientando outro colega."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.35,
        "max_tokens": 260,
        "stream": False,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError("Nao consegui falar com a Qwen.") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Resposta invalida da Qwen.") from exc
    choices = payload.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return str(message.get("content") or "").strip()

def mimo_chat_generate_remote(
    prompt: str,
    model: str | None = None,
    timeout: float = MIMO_TIMEOUT_SECONDS,
) -> str:
    api_key = read_mimo_api_key()
    if not api_key:
        raise RuntimeError("Nao encontrei a chave do MiMo.")
    model = model or resolve_mimo_remote_model()
    base_url = MIMO_BASE_URL or os.environ.get("MIMO_BASE_URL", "https://opencode.ai").strip().rstrip("/")
    if OpenAI is not None:
        client = OpenAI(api_key=api_key, base_url=base_url)
        try:
            response = client.with_options(timeout=timeout).chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Voce e um copiloto de suporte do SIG Prodata. "
                            "Responda com liberdade, contexto, objetividade e linguagem humana."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                max_tokens=260,
            )
        except Exception as exc:
            raise RuntimeError("Nao consegui falar com o MiMo remoto.") from exc
        choices = getattr(response, "choices", None) or []
        if not choices:
            return ""
        message = choices[0].message if hasattr(choices[0], "message") else choices[0].get("message") or {}
        content = getattr(message, "content", None) if message is not None else None
        if content is None and isinstance(message, dict):
            content = message.get("content")
        return str(content or "").strip()
    urls = []
    if base_url.endswith("/v1"):
        urls.append(f"{base_url}/chat/completions")
    else:
        urls.append(f"{base_url}/chat/completions")
        urls.append(f"{base_url}/v1/chat/completions")
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Voce e um copiloto de suporte do SIG Prodata. "
                    "Responda com liberdade, contexto, objetividade e linguagem humana."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 260,
        "stream": False,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error: Exception | None = None
    for url in urls:
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            payload = json.loads(raw)
            choices = payload.get("choices") or []
            if not choices:
                return ""
            message = choices[0].get("message") or {}
            return str(message.get("content") or "").strip()
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            continue
    raise RuntimeError("Nao consegui falar com o MiMo remoto.") from last_error

def mimo_vision_generate(
    prompt: str,
    image_base64: str,
    model: str | None = None,
    timeout: float = MIMO_VISION_TIMEOUT_SECONDS,
) -> str:
    api_key = read_mimo_api_key()
    if not api_key:
        raise RuntimeError("Nao encontrei a chave do MiMo.")
    model = model or resolve_mimo_remote_model()
    base_url = MIMO_BASE_URL or os.environ.get("MIMO_BASE_URL", "https://opencode.ai").strip().rstrip("/")
    if OpenAI is not None:
        client = OpenAI(api_key=api_key, base_url=base_url)
        try:
            response = client.with_options(timeout=timeout).chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Voce e um copiloto de suporte do SIG Prodata com visao de tela. "
                            "Use a imagem para identificar etapa, botoes, erros, modulo e contexto real da conversa."
                        ),
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}},
                        ],
                    },
                ],
                temperature=0.25,
                max_tokens=260,
            )
        except Exception as exc:
            raise RuntimeError("Nao consegui falar com o MiMo remoto.") from exc
        choices = getattr(response, "choices", None) or []
        if not choices:
            return ""
        message = choices[0].message if hasattr(choices[0], "message") else choices[0].get("message") or {}
        content = getattr(message, "content", None) if message is not None else None
        if content is None and isinstance(message, dict):
            content = message.get("content")
        return str(content or "").strip()
    urls = []
    if base_url.endswith("/v1"):
        urls.append(f"{base_url}/chat/completions")
    else:
        urls.append(f"{base_url}/chat/completions")
        urls.append(f"{base_url}/v1/chat/completions")
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Voce e um copiloto de suporte do SIG Prodata com visao de tela. "
                    "Use a imagem para identificar etapa, botoes, erros, modulo e contexto real da conversa."
                ),
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}},
                ],
            },
        ],
        "temperature": 0.25,
        "max_tokens": 260,
        "stream": False,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error: Exception | None = None
    for url in urls:
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            payload = json.loads(raw)
            choices = payload.get("choices") or []
            if not choices:
                return ""
            message = choices[0].get("message") or {}
            return str(message.get("content") or "").strip()
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            continue
    raise RuntimeError("Nao consegui falar com o MiMo remoto.") from last_error

def _decode_base64_image(image_base64: str) -> Image.Image | None:
    raw = (image_base64 or "").strip()
    if not raw:
        return None
    if "," in raw and raw.lower().startswith("data:image"):
        raw = raw.split(",", 1)[1]
    try:
        binary = base64.b64decode(raw)
        image = Image.open(io.BytesIO(binary))
        image.load()
        return image
    except Exception:
        return None

def local_visual_usefulness_gate(
    image_base64: str,
    current_query: str = "",
    conversation_context: str = "",
) -> tuple[bool | None, str]:
    model = _load_moondream_model()
    if model is None:
        return None, ""
    image = _decode_base64_image(image_base64)
    if image is None:
        return None, ""
    try:
        prompt = (
            "Analise esta imagem para suporte do SIG Prodata. "
            "Ela e util para entender tela, modulo, erro, campos, botoes, comprovante, documento ou contexto tecnico do atendimento? "
            "Responda estritamente com apenas uma palavra: SIM ou NAO."
        )
        verdict_data = model.query(image=image, question=prompt)
        verdict = str((verdict_data or {}).get("answer") or "").strip().upper()
        if "NAO" in verdict:
            return False, ""
        if "SIM" in verdict:
            extract_prompt = (
                "Extraia apenas o contexto tecnico util desta imagem para atendimento de suporte. "
                "Descreva tela, modulo, etapa, erro, botoes, campos, texto visivel e qualquer dado que ajude a orientar a resposta."
            )
            details_data = model.query(image=image, question=extract_prompt)
            details = str((details_data or {}).get("answer") or "").strip()
            return True, details
    except Exception:
        return None, ""
    return None, ""

def build_visual_context_summary(
    cliente: str,
    rascunho: str,
    conversation_context: str,
    image_base64: str,
    fast: bool = True,
) -> tuple[str, list[dict[str, str]]]:
    if not (image_base64 or "").strip():
        return "", []
    local_verdict, local_details = local_visual_usefulness_gate(
        image_base64,
        _last_customer_line(conversation_context, cliente, rascunho),
        conversation_context,
    )
    if local_verdict is False:
        return "", []
    current_query = _last_customer_line(conversation_context, cliente, rascunho)
    prompt = (
        "Analise a imagem da conversa e classifique se ela e UTIL ou INUTIL para orientar uma resposta de suporte.\n"
        "Responda EXATAMENTE em um dos formatos abaixo:\n"
        "UTIL: modulo/tela percebida; etapa atual; erro ou elemento relevante; impacto disso na resposta ao cliente.\n"
        "INUTIL: motivo curto.\n"
        "Considere UTIL apenas quando a imagem realmente ajudar a entender tela, modulo, etapa, erro, campos, botoes ou contexto tecnico.\n"
        "Considere INUTIL quando for imagem sem relevancia tecnica, imagem cortada demais, imagem sem contexto, foto irrelevante ou conteudo que nao ajude o atendimento.\n\n"
        f"Mensagem atual do cliente: {current_query or '(nao informada)'}\n"
        f"Contexto recente:\n{_recent_context_window(conversation_context, limit=6) or '(sem contexto)'}"
    )
    try:
        summary = mimo_vision_generate(
            prompt,
            image_base64,
            None,
            MIMO_VISION_TIMEOUT_SECONDS if fast else max(MIMO_VISION_TIMEOUT_SECONDS, 7.0),
        ).strip()
    except Exception as exc:
        return "", [{"source": "mimo_visao", "error": str(exc)}]
    if not summary:
        if local_verdict is True and local_details:
            return f"Leitura visual local:\n{local_details}", []
        return "", []
    normalized = summary.strip()
    upper = normalized.upper()
    if upper.startswith("INUTIL:") or upper.startswith("INÚTIL:"):
        return "", []
    if upper.startswith("UTIL:") or upper.startswith("ÚTIL:"):
        normalized = normalized.split(":", 1)[1].strip()
    if local_verdict is True and local_details:
        return f"Leitura visual local:\n{local_details}\n\nLeitura visual da MiMo:\n{normalized}", []
    return f"Leitura visual da MiMo:\n{normalized}", []

def generate_prodata_response_details(
    cliente: str,
    rascunho: str,
    modo: str,
    conversation_context: str = "",
    image_base64: str = "",
    fast: bool = True,
    prefer_local_fallback: bool = False,
) -> dict[str, Any]:
    started_at = time.monotonic()
    model = resolve_mimo_remote_model()
    qwen_model = resolve_qwen_model() if QWEN_ENABLED else ""
    compact_context = build_compact_context() if fast else build_context()
    current_query = _last_customer_line(conversation_context, cliente, rascunho)
    lightweight_reply = ""
    if not LOCAL_AI_ONLY_TEST and current_query:
        lightweight_reply = known_prodata_reply(current_query, rascunho, modo)
    direct_known_reply = ""
    if current_query:
        direct_known_reply = ti_gurupi_redirect_reply(current_query, rascunho) or cache_reply(_normalize_manual_text(current_query))
    if lightweight_reply and (direct_known_reply or _is_lightweight_turn(current_query)):
        winner = _build_candidate("heuristica", lightweight_reply, 0, current_query, conversation_context, False)
        winner["winner"] = True
        return {
            "final_text": winner["text"],
            "final_source": winner["source"],
            "elapsed_ms": 0,
            "candidates": [winner],
            "errors": [],
        }
    has_visual_context = bool((image_base64 or "").strip())
    local_guidance = build_local_guidance(cliente, rascunho, conversation_context, limit=3)
    visual_context = ""
    visual_errors: list[dict[str, str]] = []
    if has_visual_context:
        visual_context, visual_errors = build_visual_context_summary(
            cliente,
            rascunho,
            conversation_context,
            image_base64,
            fast=fast,
        )
        if not visual_context:
            visual_context = "Ha uma imagem recente visivel na conversa, mas a leitura visual nao retornou em tempo. Considere isso ao responder."
    prompt = build_prodata_prompt(
        cliente,
        rascunho,
        modo,
        compact_context,
        conversation_context=conversation_context,
        fast=fast,
        local_guidance=local_guidance,
        visual_context=visual_context,
    )
    heuristic_seed = ""
    local_seed = ""
    if not LOCAL_AI_ONLY_TEST:
        heuristic_seed = known_prodata_reply(current_query, rascunho, modo) if current_query else ""
        local_seed = local_response_reply(cliente, rascunho, modo, conversation_context) or heuristic_seed
    if LOCAL_QWEN_TRIAGE_ENABLED and not has_visual_context and current_query:
        triage_verdict = local_qwen_triage_should_escalate(current_query, conversation_context)
        if triage_verdict is False and local_seed:
            winner = _build_candidate("banco_local", local_seed, int((time.monotonic() - started_at) * 1000), current_query, conversation_context, False)
            winner["winner"] = True
            return {
                "final_text": winner["text"],
                "final_source": winner["source"],
                "elapsed_ms": int((time.monotonic() - started_at) * 1000),
                "candidates": [winner],
                "errors": [],
            }
    deadline = time.monotonic() + (DUAL_ENGINE_TIMEOUT_SECONDS if fast else max(DUAL_ENGINE_TIMEOUT_SECONDS, 9.0))
    candidates: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = list(visual_errors)
    if local_seed:
        candidates.append(
            _build_candidate("banco_local", local_seed, 0, current_query, conversation_context, has_visual_context)
        )
    first_ai_candidate_at = 0.0
    engine_workers = 1 + int(QWEN_ENABLED) + int(LOCAL_QWEN_RESPONSE_ENABLED)
    executor = ThreadPoolExecutor(max_workers=max(2, engine_workers))
    try:
        mimo_timeout = MIMO_TIMEOUT_SECONDS
        if has_visual_context and fast:
            mimo_timeout = max(MIMO_TIMEOUT_SECONDS, 4.5)
        qwen_future = executor.submit(qwen_generate, prompt, qwen_model, QWEN_TIMEOUT_SECONDS) if QWEN_ENABLED else None
        mimo_future = executor.submit(mimo_generate, prompt, model, mimo_timeout if fast else max(mimo_timeout, 10.0))
        futures = tuple(
            (name, future)
            for name, future in (("qwen", qwen_future), ("mimo", mimo_future))
            if future is not None
        )
        seen_sources = set()
        while time.monotonic() < deadline:
            for name, future in futures:
                if name in seen_sources or not future.done():
                    continue
                seen_sources.add(name)
                try:
                    result = (future.result() or "").strip()
                except Exception as exc:
                    errors.append({"source": name, "error": str(exc)})
                    result = ""
                if result:
                    elapsed_ms = int((time.monotonic() - started_at) * 1000)
                    candidate = _build_candidate(name, result, elapsed_ms, current_query, conversation_context, has_visual_context)
                    if (candidate.get("text") or "").strip():
                        candidates.append(candidate)
                    else:
                        errors.append({"source": name, "error": "Resposta descartada apos sanitizacao."})
                        continue
                    if name in {"mimo", "qwen"} and not first_ai_candidate_at:
                        first_ai_candidate_at = time.monotonic()
                        if not LOCAL_QWEN_RESPONSE_ENABLED and has_visual_context and name == "mimo" and candidate.get("judge_score", 0) >= 4:
                            return _finalize_candidates(candidates, errors, started_at, cliente, rascunho, modo)
                        if not LOCAL_QWEN_RESPONSE_ENABLED and name == "qwen" and candidate.get("judge_score", 0) >= 4:
                            return _finalize_candidates(candidates, errors, started_at, cliente, rascunho, modo)
                        if not LOCAL_QWEN_RESPONSE_ENABLED and candidate.get("judge_score", 0) >= 5:
                            return _finalize_candidates(candidates, errors, started_at, cliente, rascunho, modo)
                        if not LOCAL_QWEN_RESPONSE_ENABLED and candidate.get("judge_score", 0) >= 2 and not local_seed:
                            return _finalize_candidates(candidates, errors, started_at, cliente, rascunho, modo)
            if len(seen_sources) == len(futures):
                break
            now = time.monotonic()
            if not LOCAL_QWEN_RESPONSE_ENABLED and first_ai_candidate_at and (now - first_ai_candidate_at) >= ENGINE_SETTLE_SECONDS:
                return _finalize_candidates(candidates, errors, started_at, cliente, rascunho, modo)
            time.sleep(0.03)
        if qwen_future is not None and not first_ai_candidate_at and not qwen_future.done():
            try:
                result = (qwen_future.result(timeout=QWEN_LAST_CHANCE_SECONDS) or "").strip()
            except Exception:
                result = ""
            if result:
                elapsed_ms = int((time.monotonic() - started_at) * 1000)
                candidates.append(_build_candidate("qwen", result, elapsed_ms, current_query, conversation_context, has_visual_context))
        final_wait_order = sorted(
            futures,
            key=lambda item: {"qwen": 0, "mimo": 1}.get(item[0], 9),
        )
        for name, future in final_wait_order:
            if name in seen_sources:
                continue
            if name == "mimo":
                wait_limit = max(mimo_timeout, MIMO_FINAL_WAIT_SECONDS)
            else:
                wait_limit = 3.0
            try:
                result = (future.result(timeout=wait_limit) or "").strip()
            except Exception as exc:
                errors.append({"source": name, "error": str(exc)})
                result = ""
            if result:
                elapsed_ms = int((time.monotonic() - started_at) * 1000)
                candidate = _build_candidate(name, result, elapsed_ms, current_query, conversation_context, has_visual_context)
                if (candidate.get("text") or "").strip():
                    candidates.append(candidate)
                else:
                    errors.append({"source": name, "error": "Resposta descartada apos sanitizacao."})
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    details = _finalize_candidates(candidates, errors, started_at, cliente, rascunho, modo)
    if prefer_local_fallback and local_seed and details.get("final_source") == "fallback_minimo":
        details["final_text"] = local_seed
        details["final_source"] = "banco_local"
        details["candidates"] = [
            dict(candidate, winner=(candidate.get("source") == "banco_local"))
            for candidate in details.get("candidates") or []
        ]
    return details

def generate_prodata_response(
    cliente: str,
    rascunho: str,
    modo: str,
    conversation_context: str = "",
    image_base64: str = "",
    fast: bool = True,
    prefer_local_fallback: bool = False,
) -> tuple[str, str]:
    details = generate_prodata_response_details(
        cliente,
        rascunho,
        modo,
        conversation_context=conversation_context,
        image_base64=image_base64,
        fast=fast,
        prefer_local_fallback=prefer_local_fallback,
    )
    return str(details.get("final_text") or "").strip(), str(details.get("final_source") or "")

def generate_prodata_preview_details(
    cliente: str,
    rascunho: str,
    modo: str,
    conversation_context: str = "",
) -> dict[str, Any]:
    started_at = time.monotonic()
    current_query = _last_customer_line(conversation_context, cliente, rascunho)
    preview_text = ""
    preview_source = ""
    if current_query:
        preview_text = known_prodata_reply(current_query, rascunho, modo)
        preview_source = "heuristica" if preview_text else ""
    if not LOCAL_AI_ONLY_TEST:
        local_text = local_response_reply(cliente, rascunho, modo, conversation_context)
        if local_text and not preview_text:
            preview_text = local_text
            preview_source = "banco_local"
    if not preview_text:
        return {
            "final_text": "",
            "final_source": "",
            "elapsed_ms": int((time.monotonic() - started_at) * 1000),
            "candidates": [],
            "errors": [],
        }
    candidate = _build_candidate(preview_source, preview_text, int((time.monotonic() - started_at) * 1000), current_query, conversation_context, False)
    candidate["winner"] = True
    return {
        "final_text": preview_text,
        "final_source": preview_source,
        "elapsed_ms": int((time.monotonic() - started_at) * 1000),
        "candidates": [candidate],
        "errors": [],
    }

def _extract_prompt_section(prompt: str, marker: str, next_markers: tuple[str, ...]) -> str:
    start = prompt.find(marker)
    if start < 0:
        return ""
    end = len(prompt)
    for next_marker in next_markers:
        next_start = prompt.find(next_marker, start + len(marker))
        if next_start >= 0:
            end = min(end, next_start)
    return prompt[start:end].strip()

def compact_mimo_cli_prompt(prompt: str, max_chars: int = 4200) -> str:
    prompt = (prompt or "").strip()
    if len(prompt) <= max_chars:
        return prompt
    markers = (
        "\nContexto da conversa:",
        "\nConhecimento manual relevante:",
        "\nPistas do banco local:",
        "\nMensagem do cliente:",
        "\nRascunho do atendente:",
    )
    blocks = [
        _extract_prompt_section(prompt, marker, markers)
        for marker in markers
    ]
    blocks = [block for block in blocks if block]
    compact = "\n\n".join([
        "Voce e um copiloto de suporte do SIG Prodata. Responda somente com a mensagem final para o cliente.",
        "Use portugues do Brasil, tom humano, curto e profissional. Nao invente procedimento, prazo, link ou garantia.",
        "Se faltar informacao tecnica, peca print, mensagem exata do erro, CNPJ/empresa ou etapa onde ocorreu.",
        "Quando o cliente falar em certificado, trate como certificado digital A1/A3 usado para emissao fiscal.",
        "Acompanhe o contexto recente da conversa e responda ao ponto atual do cliente.",
        *blocks,
        "Mensagem final:",
    ]).strip()
    if len(compact) <= max_chars:
        return compact
    return compact[-max_chars:]

def mimo_generate(prompt: str, model: str | None = None, timeout: float = 20.0) -> str:
    try:
        return mimo_chat_generate_remote(prompt, resolve_mimo_remote_model(), timeout)
    except Exception:
        api_key = read_mimo_api_key()
        if not api_key:
            raise RuntimeError("Nao encontrei a chave do MiMo.")
        local_model = resolve_model()
        mimo_cli = next((candidate for candidate in MIMO_CLI_CANDIDATES if candidate and Path(candidate).exists()), "")
        if not mimo_cli:
            raise RuntimeError("Nao encontrei o binario local do MiMo.")
        env = os.environ.copy()
        env["MIMO_API_KEY"] = api_key
        local_timeout = max(timeout, MIMO_CLI_TIMEOUT_SECONDS)
        cli_prompt = compact_mimo_cli_prompt(prompt)
        try:
            result = subprocess.run([mimo_cli, "run", "--model", local_model, cli_prompt], text=True, capture_output=True, env=env, timeout=local_timeout, check=False)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise RuntimeError("Nao consegui falar com o MiMo local.") from exc
        output = (result.stdout or "").strip()
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "").strip() or "Nao consegui falar com o MiMo local.")
        return output

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def do_POST(self):
        if self.path == "/api/melhorar":
            self.handle_melhorar()
            return
        if self.path == "/api/aprender":
            self.handle_aprender()
            return
        self.send_error(404)

    def handle_aprender(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        payload = json.loads(body or "{}")
        cliente = payload.get("cliente", "").strip()
        rascunho = payload.get("rascunho", "").strip()
        resposta = payload.get("resposta", "").strip()
        aprendizado = payload.get("aprendizado", "").strip()
        if not resposta and not aprendizado:
            self.respond_json({"error": "Informe uma resposta aprovada ou uma regra nova."}, 400)
            return
        save_learning(cliente, rascunho, resposta, aprendizado)
        self.respond_json({"ok": True})

    def handle_melhorar(self):
        if self.path != "/api/melhorar":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        payload = json.loads(body or "{}")
        cliente = payload.get("cliente", "").strip()
        rascunho = payload.get("rascunho", "").strip()
        modo = payload.get("modo", "profissional").strip()
        if not cliente and not rascunho:
            self.respond_json({"error": "Informe a mensagem do cliente ou seu rascunho."}, 400)
            return
        try:
            details = generate_prodata_response_details(cliente, rascunho, modo, fast=True)
            result = str(details.get("final_text") or "").strip()
            origem = str(details.get("final_source") or "")
        except RuntimeError:
            result = local_response_reply(cliente, rascunho, modo) or contextual_fallback(cliente, rascunho, modo)
            origem = "banco_local"
            details = {"candidates": [], "errors": [], "elapsed_ms": 0}
        self.respond_json({"resposta": (result or "").strip(), "origem": origem, "candidatos": details.get("candidates") or [], "tempo_ms": int(details.get("elapsed_ms") or 0)})

    def respond_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def main():
    port = 8787
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Agente Prodata aberto em http://127.0.0.1:{port}")
    server.serve_forever()

if __name__ == "__main__":
    main()
