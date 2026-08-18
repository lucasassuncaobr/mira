# Aprova

MVP para transformar provas em PDF em cadernos de questões interativos.

## O que já funciona

- Upload de PDF de até 20 MB com texto selecionável.
- Detecção de questões numeradas e alternativas de A a E.
- Revisão e edição do enunciado, alternativas, disciplina e assunto.
- Cadastro manual do gabarito clicando na letra correta.
- Resolução do caderno e registro de tentativas.
- Persistência local em SQLite.

## Executar

Requer Node.js 24 ou superior.

```bash
npm install
npm run dev
```

A interface abre em `http://localhost:5173` e a API em `http://localhost:3333`.

## Limitações atuais

PDFs compostos somente por imagens ainda precisam da etapa de OCR. Layouts em múltiplas colunas, imagens dentro das questões e gabaritos em arquivos separados serão tratados nas próximas versões.

## Estrutura

- `apps/web`: React e Vite.
- `apps/api`: Express, extração de PDF e SQLite.
