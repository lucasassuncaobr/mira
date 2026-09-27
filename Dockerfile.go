# Build stage
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o mira-goapi ./apps/goapi/main.go

# Runtime stage (APENAS binários C/C++ + Go binary)
FROM alpine:latest
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-por
WORKDIR /app
COPY --from=builder /app/mira-goapi .
EXPOSE 3333
VOLUME /app/data
ENTRYPOINT ["./mira-goapi"]