# trading-engine

## Run 24/7 (PM2)

```bash
npm install
npm run build:engine
npm run build:dashboard
npm run pm2:start
pm2 save
pm2 startup
```

Useful commands:

```bash
pm2 logs trading-engine
pm2 logs dashboard
npm run pm2:restart
npm run pm2:stop
```
