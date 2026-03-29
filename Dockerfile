# Build stage: compile native dependencies
FROM node:20-slim AS builder
RUN set -ex; \
    # Try official repos first (works for US/EU/HK servers with good connectivity) \
    if apt-get update 2>/dev/null; then \
      echo "Using default Debian mirrors"; \
    else \
      echo "Default mirrors failed, trying Aliyun mirrors..."; \
      sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
        || sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list 2>/dev/null || true; \
      apt-get update; \
    fi; \
    apt-get install -y --no-install-recommends build-essential python3 g++ make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Runtime stage: clean image without build tools
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
EXPOSE 8096
CMD ["node", "src/index.js"]
