#!/usr/bin/env python3
import json
import shutil
from datetime import datetime
from pathlib import Path

import server


ROOT = Path(__file__).resolve().parent
HISTORY = ROOT / "dados" / "atendimentos.jsonl"
LEARNED = ROOT / "memoria" / "aprendizados.md"
INDEX = ROOT / "memoria" / "knowledge_index.json"


def load_records() -> list[dict]:
    records = []
    if not HISTORY.exists():
        return records
    for raw in HISTORY.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def build_index(records: list[dict]) -> tuple[dict, list[dict], list[dict]]:
    entries_by_signature: dict[str, dict] = {}
    clean_records: list[dict] = []
    rejected: list[dict] = []
    for record in records:
        question = " ".join(str(record.get("cliente") or "").split())
        answer = " ".join(str(record.get("resposta_aprovada") or "").split())
        if not server.is_high_quality_pair(question, answer):
            rejected.append({**record, "motivo_rejeicao": "baixa_qualidade"})
            continue
        category = server.classify_learning(question, answer)
        confidence = server.calculate_learning_confidence(question, answer, category, 1)
        if confidence < server.LEARNING_MIN_CONFIDENCE:
            rejected.append({**record, "motivo_rejeicao": "baixa_confianca"})
            continue
        signature = server._learning_signature(question, answer)
        now = str(record.get("data") or "")
        entry = entries_by_signature.get(signature)
        if entry:
            entry["usos"] += 1
            entry["ultima_atualizacao"] = max(str(entry.get("ultima_atualizacao") or ""), now)
            entry["confianca"] = server.calculate_learning_confidence(question, answer, category, entry["usos"])
            continue
        normalized_record = {
            **record,
            "cliente": question,
            "resposta_aprovada": answer,
            "categoria": category,
            "confianca": confidence,
            "assinatura": signature,
        }
        clean_records.append(normalized_record)
        entries_by_signature[signature] = {
            "assinatura": signature,
            "data": now,
            "ultima_atualizacao": now,
            "pergunta": question,
            "resposta": answer,
            "categoria": category,
            "confianca": confidence,
            "usos": 1,
            "aprovado": True,
        }
    index = {
        "version": 1,
        "entries": sorted(
            entries_by_signature.values(),
            key=lambda item: (-float(item.get("confianca") or 0), -int(item.get("usos") or 0), str(item.get("categoria") or "")),
        ),
        "categorias": {},
        "metricas": {},
    }
    server._rebuild_knowledge_metrics(index, total_seen=len(records), rejected=len(rejected))
    return index, clean_records, rejected


def write_clean_learned(clean_records: list[dict]) -> None:
    lines = [
        "# Aprendizados consolidados\n",
        "\n",
        "Arquivo gerado automaticamente por limpar_aprendizados.py. O histórico bruto fica em dados/atendimentos.jsonl.\n",
    ]
    useful_records = [
        record for record in clean_records
        if float(record.get("confianca") or 0) >= server.LEARNING_MIN_CONFIDENCE
    ]
    for record in useful_records[-500:]:
        date = str(record.get("data") or "")
        lines.append(f"\n## {date}\n")
        lines.append(f"- Categoria: {record.get('categoria', 'geral')}\n")
        lines.append(f"- Confianca: {record.get('confianca', 0)}\n")
        lines.append(f"- Cliente perguntou: {record.get('cliente', '')}\n")
        lines.append(f"- Resposta aprovada: {record.get('resposta_aprovada', '')}\n")
    LEARNED.write_text("".join(lines), encoding="utf-8")


def main() -> None:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = ROOT / "Backups" / f"aprendizados-{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=True)
    if HISTORY.exists():
        shutil.copy2(HISTORY, backup_dir / HISTORY.name)
    if LEARNED.exists():
        shutil.copy2(LEARNED, backup_dir / LEARNED.name)

    records = load_records()
    index, clean_records, rejected = build_index(records)

    server._write_json(INDEX, index)
    clean_history = ROOT / "dados" / "atendimentos.clean.jsonl"
    clean_history.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in clean_records),
        encoding="utf-8",
    )
    rejects_path = ROOT / "dados" / "learning_rejects.clean.jsonl"
    rejects_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in rejected),
        encoding="utf-8",
    )
    write_clean_learned(clean_records)

    print(f"Backup: {backup_dir}")
    print(f"Total bruto: {len(records)}")
    print(f"Validos deduplicados: {len(index['entries'])}")
    print(f"Registros limpos: {len(clean_records)}")
    print(f"Rejeitados: {len(rejected)}")
    print(f"Taxa qualidade: {index['metricas']['taxa_qualidade']}")


if __name__ == "__main__":
    main()
