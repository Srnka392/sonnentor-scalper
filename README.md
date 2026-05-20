# Sonnentor → Shopify migration

Scrapes sonnentor.com (cs-cz locale) and imports content into a Shopify Admin API.

## Layout

```
migration/
  src/
    cli.js              CLI entry — `urls`, `scrape`, `import`, `report`
    config.js           env loading
    fetcher.js          HTTP fetch with caching + concurrency limit
    sourceUrls.js       collect URLs from sitemaps + herbarium crawl
    scrapers/
      page.js
      article.js
      recipe.js
      herb.js
    shopify/
      client.js         Admin GraphQL client
      pages.js          page mutations
      articles.js       article + blog mutations
      files.js          image upload (stagedUploadsCreate + fileCreate)
      products.js       handle/title lookup + unresolved CSV
    importer.js
  data/
    urls.json           URL inventory (output of `urls`)
    pages.json          scraped page data
    articles.json
    recipes.json
    herbarium.json
    raw/                cached source HTML (gitignored)
    images/             downloaded images (gitignored)
    unresolved-products.csv
```

## Setup

```bash
cd migration
cp .env.example .env   # fill in SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN
npm install
```

The Shopify admin token must be a **custom app** token (`shpat_...`) with scopes:

- `write_content`
- `write_files`
- `read_products`

## Workflow

```bash
npm run urls                   # collect URL inventory → data/urls.json
npm run scrape -- pages        # scrape one section at a time
npm run scrape -- articles
npm run scrape -- recipes
npm run scrape -- herbarium
npm run import -- pages --dry  # dry-run: show what would change
npm run import -- pages        # do it
npm run report                 # summary + unresolved products list
```

All importers are **idempotent** — re-running matches by handle and updates instead of duplicating.
