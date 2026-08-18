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

Se quiser capturar texto apenas selecionando com o mouse, ative "Capturar seleção". O app tenta ler a seleção primária do sistema, copia automaticamente para o clipboard e preenche o campo "Mensagem do cliente" sem precisar apertar `Ctrl+C`.

Use "OCR imagem" para abrir uma imagem, arrastar um recorte e extrair o texto automaticamente.

### Janela flutuante ligada ao ZapZap

Use esta versao para o agente tentar ler a conversa aberta no ZapZap sem copiar/colar:

```bash
cd ~/Projetos/zapzap-prodata-agent
./iniciar_zapzap_com_agente.sh
```

Essa versao conecta a janela flutuante ao WhatsApp aberto pela porta local `9222`.
O ZapZap precisa estar aberto manualmente com a depuracao ativa antes de iniciar o agente.

- "Ler conversa": busca o texto visivel da conversa.
- "Sugerir": gera a resposta.
- "Aceitar" ou `Ctrl+Enter`: tenta preencher a caixa de mensagem do ZapZap.
- "Aprender": salva a resposta aprovada na memoria local.

Se o ZapZap fechar, o agente nao vai abrir novamente sozinho. Abra o ZapZap manualmente com depuracao ativa e reinicie o agente se precisar reconectar.

### Assistente dentro do ZapZap

Use esta versao para evitar conflito com PaperWM/foco do mouse. Ela injeta o painel do Prodata Assist dentro do proprio ZapZap:

```bash
cd ~/Projetos/zapzap-prodata-agent
./iniciar_inline.sh
```

Essa versao nao cria janela flutuante separada.

Para reiniciar apenas o agente inline:

```bash
cd ~/Projetos/zapzap-prodata-agent
./reiniciar_zapzap_inline.sh
```

### Versao navegador

1. Garanta que o cliente local do MiMo esteja acessivel no ambiente.

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

## MiMo

A configuracao do MiMo fica em `modelo.txt`.
Por padrão ele aponta para `xiaomi/mimo-v2.5`.
O agente usa o MiMo com a memoria de `memoria/` e os atendimentos aprovados em `dados/atendimentos.jsonl` para aprender a rotina.
Se quiser trocar, altere o conteudo para outro perfil/modelo suportado pelo backend MiMo.
