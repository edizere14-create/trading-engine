# ── Multi-stage build: Node dashboard + Python engine ───────────────────────
FROM node:22-slim AS dashboard-builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts
COPY dashboard/ dashboard/
COPY next.config.js tailwind.config.js postcss.config.js ./
RUN npx next build dashboard

# ── Runtime image ───────────────────────────────────────────────────────────
FROM python:3.13-slim

# System deps for aiohttp (C extensions) and Node for dashboard
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node deps (production only — for Next.js runtime)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

# Copy built dashboard
COPY --from=dashboard-builder /app/dashboard/.next dashboard/.next
COPY dashboard/app dashboard/app

# Copy all source
COPY *.py ./
COPY advanced_strategies/ advanced_strategies/
COPY scripts/ scripts/
COPY src/ src/
COPY data/ data/
COPY next.config.js tailwind.config.js postcss.config.js tsconfig.json ./

# Create logs dir
RUN mkdir -p logs

EXPOSE 8000 3000

# Default: start the trading bot (override in compose per service)
CMD ["python", "main.py"]
