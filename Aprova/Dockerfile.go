# Mira Go — API Fiber + frontend AlpineJS, binário único estático.
# Zero GPL/AGPL no runtime (ver NOTICE-THIRD-PARTY).
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY apps/goapi/go.mod apps/goapi/go.sum apps/goapi/
RUN cd apps/goapi && go mod download
RUN apt-get update && apt-get install -y --no-install-recommends libtesseract-dev libleptonica-dev && rm -rf /var/lib/apt/lists/*
COPY apps/goapi/*.go apps/goapi/
COPY apps/goapi/web apps/goapi/web/
RUN go run github.com/yfedoseev/pdf_oxide/go/cmd/install@v0.3.78 -dir /opt/pdf-oxide
RUN cd apps/goapi && CGO_ENABLED=1 CGO_CFLAGS="-I/opt/pdf-oxide/include" CGO_LDFLAGS="-L/opt/pdf-oxide/lib/linux_amd64 -lpdf_oxide -lm -lpthread -ldl -lrt -lgcc_s -lutil" go build -o /out/mira-goapi .
RUN du -h /out/mira-goapi && du -sh apps/goapi/web

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libtesseract5 liblept5 tesseract-ocr tesseract-ocr-por ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/mira-goapi ./mira-goapi
COPY apps/goapi/web ./web
ENV PORT=3333
ENV MIRA_DATA_DIR=/app/data
ENV MIRA_WEB_DIR=/app/web
EXPOSE 3333
VOLUME /app/data
CMD ["./mira-goapi"]
