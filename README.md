# Brandled Scraper

Standalone scraping service for the Brandled top-posts knowledge base. Scrapes high-performing content from X/Twitter and LinkedIn, classifies it, generates embeddings, and upserts to the shared Pinecone index.

## Architecture

```
This Service (writes) → Pinecone ← Brandled App (reads)
```

No API layer between them — they share the same Pinecone index.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browser
npx playwright install chromium

# 3. Copy environment variables
cp .env.example .env
# Fill in your values (see .env.example for details)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | For embeddings + classification |
| `PINECONE_API_KEY` | ✅ | Same key as Brandled app |
| `PINECONE_INDEX_NAME` | ✅ | Same index as Brandled app |
| `TWITTER_SCRAPER_USERNAME` | ✅ | Dedicated X account for scraping |
| `TWITTER_SCRAPER_PASSWORD` | ✅ | Same account password |
| `TWITTER_SCRAPER_EMAIL` | ⬜ | Same account email (helps with auth) |
| `LINKEDIN_LI_AT_COOKIE` | ⬜ | LinkedIn session cookie (recommended) |

## Usage

### Initial Seed

```bash
# Full seed — all 6 niches, both platforms (~2-3 hours)
npm run seed

# Test with 2 creators per niche, don't write to Pinecone
npm run seed:test

# Seed one niche only
node scripts/seed.js --niche saas

# Seed one platform only
node scripts/seed.js --platform x

# Custom options
node scripts/seed.js --niche ai_tech --limit 5 --dry-run --min-score 200
```

### Weekly Refresh

```bash
# Refresh all niches (fetches recent posts only)
npm run refresh

# Refresh one niche
node scripts/refresh.js --niche marketing
```

## Pipeline

```
Creator Registry → Scrape → Normalize → Classify → Embed → Upsert
  (creators.json)   (X+LI)   (common     (GPT-4o    (OpenAI)  (Pinecone)
                               schema)     -mini)
```

## Costs

| Item | Volume | Cost |
|------|--------|------|
| X scraping | Any | $0 (agent-twitter-client) |
| LinkedIn scraping | Any | $0 (Playwright) |
| Classification | 2,500 posts | ~$0.40 |
| Embeddings | 2,500 posts | ~$0.05 |
| **Total seed** | | **~$0.45** |
| **Weekly refresh** | | **~$0.10** |

## File Structure

```
config/creators.json     — 360 creators across 6 niches
clients/x-client.js      — X/Twitter scraper (agent-twitter-client)
clients/linkedin-client.js — LinkedIn scraper (Playwright)
pipeline/normalizer.js   — Raw data → common schema
pipeline/classifier.js   — GPT classification
pipeline/embedder.js     — OpenAI embeddings
pipeline/embeddings.js   — Low-level embedding utility
pinecone/client.js       — Pinecone connection + upsert
jobs/seed.js             — Full seed pipeline
scripts/seed.js          — CLI entry: node scripts/seed.js
scripts/refresh.js       — CLI entry: node scripts/refresh.js
```
