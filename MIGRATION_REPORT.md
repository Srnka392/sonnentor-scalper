# Migration report — sonnentor.com → sonnentor-dev.myshopify.com

Living document. Updated as migration progresses.

## Sections still to build in the theme

These content blocks existed on the old store and were **stripped** from the imported page bodies, on the assumption that they will be reintroduced via the customizer using dedicated theme sections. None of the existing theme sections match.

### 1. Gallery section

- **Source block:** `pimcore_area_gallery` (`/cs-cz/caj-na-miru` and others)
- **Old store behavior:** a slider/grid of clickable images opening a lightbox.
- **Existing theme equivalent:** none. `image-banner.liquid` is a single banner, `logo-list.liquid` is for logos.
- **Recommended action:** scaffold a `components/gallery-grid/` section (image grid + lightbox) and add it to relevant pages via the customizer.
- **Affected pages so far:** `caj-na-miru`.

### 2. Contact-person section

- **Source block:** `pimcore_area_contact-person` (`/cs-cz/caj-na-miru` etc.)
- **Old store behavior:** a card with a person's photo, name, role, email, phone.
- **Existing theme equivalent:** none. `contact-form.liquid` is a form, not a person card. `main-contact.liquid` is the contact page template.
- **Recommended action:** scaffold a `components/contact-person/` section. Add to relevant pages via the customizer.
- **Affected pages so far:** `caj-na-miru`.

### 3. Campaign / promo landing pages — _PO review pending; rebuild via customizer_

The old store's promo/marketing landing pages are basically a mix of product
teasers and article teasers, with very little static copy. Importing them as
`Online Store → Pages` with HTML body is a stop-gap — the proper solution is a
custom page template + sections in the customizer (featured-collection,
featured-blog, image-banner, etc.).

**Current status:** these pages **are imported** to give the Product Owner
something to review before deciding the final UX. Once the PO confirms the
direction, they should be deleted from Shopify and rebuilt as customizer
templates. The URL collector has `landing-pages` ready to add back to
`EXCLUDED_STATIC_PAGE_PREFIXES` in `src/sourceUrls.js` when that happens.

| Old store URL | Status | Recommended approach |
|---|---|---|
| `/cs-cz/landing-pages/*` (25 pages — `landing-pages/caj-chvilka-pro-sebe/*`, `landing-pages/udrzitelnost/*`, etc.) | imported (PO review) | Replace with customizer-driven landing template using existing sections (featured-collection, featured-blog, image-banner). |
| `/cs-cz/prijdte-si-pro-radost` | imported (PO review) | Same — rebuild via customizer. |

If more pages turn out to be product/article teaser collages rather than static
copy, treat them the same way: delete from Shopify, exclude in
`src/sourceUrls.js`, and add a row here.

## Token & scope status

- **Token in use:** `shpca_…` (Theme Access app) from `config.yml`. Confirmed working for `write_content`, `read_products`, and file reads.
- **Security note:** the token was printed to the conversation chat early in the migration. Rotate it after migration completes (Settings → Apps → Develop apps → Revoke & regenerate).

## Pages — known cleanup applied during scrape

The page body imports keep the original Pimcore HTML structure with CSS classes preserved. The legacy styling lives in `css/pages/_legacy-sonnentor.css` and is loaded via `css/theme.css`.

Stripped from every page body:

- `pimcore_area_hero-teaser` and `.img-text-teaser--big` (hero blocks — will be added back via a customizer hero section)
- `pimcore_area_gallery` (see above)
- `pimcore_area_contact-person` (see above)
- "Inspirujte se v galerii:" and "Pro bližší informace kontaktujte:" heading-only wysiwyg blocks
- Breadcrumbs, share buttons, navigation, scripts, forms, recommendations, cookies, related sections

## Metafields written by the importer

All metafields live in the **`sga`** namespace on the `ARTICLE` owner type
(so they work for articles in `news`, `recipes`, and `herbarium` blogs alike).

| Key | Type | Where used |
|---|---|---|
| `sga.related_products` | `list.product_reference` | news articles, recipes, herbs |
| `sga.related_articles` | `list.article_reference` | news articles (from "Mohlo by vás také zajímat:") |
| `sga.total_time_minutes` | `number_integer` | recipes only |
| `sga.servings` | `number_integer` | recipes only |
| `sga.ingredients` | `json` | recipes only |
| `sga.instructions` | `json` | recipes only |
| `sga.latin_name` | `single_line_text_field` | herbs only |

> Note: the very first article import run used `article.related_products`. Those
> stale metafields still exist on every article but are not referenced. They can
> be cleaned up later with a `metafieldsDelete` pass if desired.

## Final import counts (2026-05-19 — sequential re-import with sga namespace)

| Section | Created | Updated | Failed | Notes |
|---|---:|---:|---:|---|
| Pages (`Online Store → Pages`) | 0 | 179 | 0 | — |
| Articles (blog `news`) | 0 | 322 | 0 | 322 related_articles linked. 2591 unresolved products. |
| Recipes (blog `recipes`) | 778 | 0 | 0 | 1875 unresolved products. |
| Herbarium (blog `herbarium`) | 55 | 0 | 0 | 396 unresolved products. |

Total: **1 334 content items, 0 failures.**

Unresolved products are saved to `data/unresolved-products.csv` and will resolve
automatically when those products land in the dev store (re-run the importer to
update metafields).

## Product matching results (image-code + title fuzzy)

After the initial import, `src/scripts/matchProducts.js` ran a two-stage matcher
against the 469 products in `sonnentor-dev.myshopify.com`:

- **Stage 1 — image-code match**: extract the 4–6 digit product code from the
  source store image filename (e.g. `00734.51c52bd1.jpg`) and look it up against
  the Shopify CDN filename. **364 source products resolved.**
- **Stage 2 — title fuzzy match**: token Jaccard similarity (≥ 0.5 with ≥ 0.15
  gap to the second candidate). **94 source products resolved.**

Unresolved reference count after a re-import that picked up the new resolutions:

| Section | Before matching | After matching | Δ |
|---|---:|---:|---:|
| Articles | 2 591 | 410 | -84% |
| Recipes | 1 875 | 37 | -98% |
| Herbarium | 396 | 18 | -95% |
| **Total** | **4 862** | **465** | **-90%** |

Of the 174 still-ambiguous source products, **139 were verified as stale**
(HEAD-checked, the old store 301-redirects to a category — product was renamed
or discontinued). They are logged in `data/AMBIGUOUS_REVIEW.stale.json`.
The remaining **35 products** are listed in `data/AMBIGUOUS_REVIEW.md` for
manual review (3 high-confidence, 5 medium, 27 low/none). Workflow:

1. Open `data/AMBIGUOUS_REVIEW.md`, place `x` inside `[ ]` next to the correct
   candidate for each entry.
2. Run `node src/scripts/applyMapping.js` to persist accepted mappings into
   `data/shopify-state.json`.
3. Re-run `npm run import -- articles && npm run import -- recipes && npm run import -- herbarium` to refresh the `sga.related_products` metafields.

## Open items

- [x] Full pages import (179)
- [x] Articles import (322) → blog `news` with `sga.related_products` + `sga.related_articles`
- [x] Recipes import (778) → blog `recipes` with `sga.*` metafields
- [x] Herbarium import (55) → blog `herbarium` with `sga.latin_name` + `sga.related_products`
- [ ] Image upload pipeline (stagedUploadsCreate + fileCreate) — body images and hero images currently reference sonnentor.com URLs
- [ ] Review `data/unresolved-products.csv` (4 862 entries) and either add missing products to the dev store or update mapping
- [ ] Build `components/gallery-grid/` section in the theme (see Section 1 above)
- [ ] Build `components/contact-person/` section in the theme (see Section 2 above)
- [ ] Theme — render the `sga.*` metafields on article/recipe/herb templates (ingredients list, instructions, related products carousel, related articles, latin name…)
- [ ] Rotate the Shopify access token (it was printed to chat history earlier)
- [x] Probe page `migration-write-probe` — deleted via API on 2026-05-19.

## Body wrapping for legacy CSS

Article, recipe and herbarium bodies are wrapped at import time in
`<div class="pimcore_area_content legacy-migrated">…</div>` so that the
`css/pages/_legacy-sonnentor.css` selectors (all scoped to `.pimcore_area_content …`)
apply. Pages already contain native `pimcore_area_content` wrappers in their
source HTML and are not double-wrapped.
