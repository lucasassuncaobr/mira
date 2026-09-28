# Build stage
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
COPY main.go ./
COPY index.html ./
COPY styles.css ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mira .

# Runtime stage
FROM alpine:latest
WORKDIR /app
COPY --from=builder /mira ./mira
EXPOSE 3000
ENV PORT=3000
ENTRYPOINT ["./mira"]
