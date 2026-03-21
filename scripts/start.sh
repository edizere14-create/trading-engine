#!/bin/sh
# Start the dashboard in the background
npx next start dashboard --port ${PORT:-3000} &

# Start the trading engine in the foreground
npx ts-node src/index.ts
