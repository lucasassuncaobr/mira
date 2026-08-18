# Agente Prodata para ZapZap

Copiloto local para melhorar respostas de atendimento antes de enviar no ZapZap/WhatsApp.

## Como usar

### Aplicativo nativo

Use esta versao se quiser o agente fora do navegador:

```bash
cd ~/Projetos/zapzap-prodata-agent
./iniciar_desktop.sh
```

No app nativo, ative "Monitorar clipboard". Ao copiar uma mensagem no ZapZap, o texto entra automaticamente no campo "Mensagem do cliente".

### Janela flutuante ligada ao ZapZap

Use esta versao para o agente tentar ler a conversa aberta no ZapZap sem copiar/colar:

```bash
cd ~/Projetos/zapzap-prodata-agent
./iniciar_zapzap_com_agente.sh
```

Essa versao abre o ZapZap com depuracao local do QtWebEngine na porta `9222` e conecta a janela flutuante ao WhatsApp aberto.

- "Ler conversa": busca o texto visivel da conversa.
- "Sugerir": gera a resposta.
- "Aceitar" ou `Ctrl+Enter`: tenta preencher a caixa de mensagem do ZapZap.
- "Aprender": salva a resposta aprovada na memoria local.

Se o ZapZap ja estiver aberto sem esse lancador, feche-o e abra por `iniciar_zapzap_com_agente.sh`.

### Assistente dentro do ZapZap

Use esta versao para evitar conflito com PaperWM/foco do mouse. Ela injeta o painel do Prodata Assist dentro do proprio ZapZap:

```bash
cd ~/Projetos/zapzap-prodata-agent
./iniciar_inline.sh
```

Essa versao nao cria janela flutuante separada.

Para fechar as instancias atuais do ZapZap e abrir do jeito correto:

```bash
cd ~/Projetos/zapzap-prodata-agent
./reiniciar_zapzap_inline.sh
```

### Versao navegador

1. Inicie o Ollama, se ele ainda nao estiver aberto:

```bash
ollama serve
```

2. Abra o agente:

```bash
cd ~/Projetos/zapzap-prodata-agent
python3 server.py
```

3. Acesse no navegador:

```text
http://127.0.0.1:8787
```

4. No ZapZap, copie a mensagem do cliente.
5. Cole no campo "Mensagem do cliente".
6. Escreva seu rascunho, se quiser.
7. Clique em "Melhorar resposta".
8. Revise, copie e envie manualmente no ZapZap.
9. Quando a resposta ficar boa, clique em "Salvar aprendizado" para o agente aprender com aquele atendimento.

## Memoria

Edite os arquivos em `memoria/` para ensinar sua rotina:

- `perfil_atendimento.md`
- `prodata_faq.md`
- `procedimentos.md`
- `frases_padrao.md`
- `aprendizados.md`

O botao "Salvar aprendizado" grava exemplos aprovados em:

- `memoria/aprendizados.md`: memoria usada nas proximas respostas.
- `dados/atendimentos.jsonl`: historico local dos atendimentos salvos.

Quanto mais respostas aprovadas e regras voce salvar, mais o agente tende a copiar seu jeito de atender.

## Modelo

O modelo padrao fica em `modelo.txt`.
Para trocar, altere o conteudo para outro modelo instalado no Ollama.
