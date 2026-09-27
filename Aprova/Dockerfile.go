# Mira Go — API Fiber + frontend AlpineJS, binário único estático.
# Zero GPL/AGPL no runtime (ver NOTICE-THIRD-PARTY).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY apps/goapi/go.mod apps/goapi/go.sum apps/goapi/
RUN cd apps/goapi && go mod download
COPY apps/goapi/*.go apps/goapi/
RUN cd apps/goapi && CGO_ENABLED=0 go build -o /out/mira-goapi .

FROM node:24-alpine
# Python (pipeline pdfplumber/pypdfium2) + Node (ponte OCR temporária).
RUN apk add --no-cache python3 py3-pip \
  && pip install --no-cache --break-system-packages pdfplumber pypdfium2 Pillow
WORKDIR /app
COPY --from=build /out/mira-goapi ./mira-goapi
COPY apps/api/python ./python
COPY apps/goapi/web ./web
COPY apps/goapi/bridge ./bridge
RUN cd bridge && npm install --omit=dev --no-audit --no-fund
ENV PORT=3333
ENV MIRA_DATA_DIR=/app/data
ENV MIRA_PY_DIR=/app/python
ENV MIRA_WEB_DIR=/app/web
ENV MIRA_BRIDGE=/app/bridge/ocr-bridge.mjs
EXPOSE 3333
VOLUME /app/data
CMD ["./mira-goapi"]
