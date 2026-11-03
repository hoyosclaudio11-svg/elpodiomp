# 🏆 El Podio MP

> **EN:** AI-powered price comparison platform aggregating offers from Mercado Libre, AliExpress and local food stores. Live at [elpodiomp.com.ar](https://elpodiomp.com.ar).

**El Podio MP** reúne las mejores ofertas en un solo lugar: tecnología, hogar, moda y una sección gastronómica con locales reales, operando en producción con dominio propio.

## Qué hace

- **Ofertas agregadas por categoría** — Mercado Libre, AliExpress, Tech, Hogar y Moda. Scraping con **Puppeteer** (plugin stealth) y cache HTML por categoría para servir rápido.
- **Sección de comidas con IA** — altas de locales gastronómicos asistidas con **Google Gemini**, y parser de ofertas (panadería, cena, express) con **DeepSeek**.
- **Imágenes de productos con IA** — generación vía **OpenRouter** con fallback a **Leonardo.ai**.
- **Servidor Express** endurecido: helmet, rate-limiting y compresión.

## Stack

Node.js (≥18) · Express · Puppeteer (stealth) · Cheerio · Gemini API · DeepSeek · OpenRouter · Leonardo.ai

## Correr en local

```bash
npm install
cp .env.example .env   # completar credenciales
npm start              # http://localhost:3000
npm run dev            # modo watch
npm run add-food       # parser de ofertas gastronómicas con IA
```

## Variables de entorno

Todas listadas en [`.env.example`](.env.example): credenciales de Mercado Libre Developers, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `LEONARDO_API_KEY`, `DOMAIN`, `BASE_URL` y `PORT`.

## Deploy

En producción corre en [Render](https://render.com) (config incluida en `render.yaml`), con dominio propio **elpodiomp.com.ar**. El puerto lo asigna la variable `PORT` de Render.

## Licencia

[MIT](LICENSE)
