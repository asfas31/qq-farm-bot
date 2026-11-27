FROM golang:1.23-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN GOPROXY=https://goproxy.cn,direct go mod download

COPY . .

RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o farm-capture .

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata wget && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

WORKDIR /app

COPY --from=builder /app/farm-capture .
COPY --from=builder /app/config.yaml .
RUN mkdir -p certs

# The service allocates proxy ports from PROXY_BASE_PORT through the next 99 ports.
# Publish the matching range (5000-5099 by default) when running the container.
EXPOSE 8080 5000-5099

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8080/api/health || exit 1

CMD ["./farm-capture"]
