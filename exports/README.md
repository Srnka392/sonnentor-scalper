# Content export for Shopify migration — Matrixify format

This bundle contains **Matrixify-ready CSV templates** for exporting content from the legacy Pimcore-based store (sonnentor.com) into the new Shopify store via the **[Matrixify](https://matrixify.app/) app**.

| File | Matrixify entity | Sheet name | Description |
|---|---|---|---|
| `files.csv` | Files | `Files` | Thumbnail images — must be imported first (see "Import order" below) |
| `articles.csv` | Blog Posts | `Blog Posts` | Tips & articles (target blog handle: `news`) |
| `recipes.csv` | Blog Posts | `Blog Posts` | Recipes (target blog handle: `recipes`) — body intentionally empty (theme renders from metafields) |
| `herbarium.csv` | Blog Posts | `Blog Posts` | Herbarium / plants (target blog handle: `herbarium`) |
| `products-mapping.csv` | (lookup table) | — | Helper: legacy source handle → Shopify product ID (482 products) |

Pages (landing pages, category pages, etc.) are not part of this migration — those will be rebuilt in the Shopify Theme Customizer.

---

## Import order

Run imports in this order, each one via Matrixify → Import → Upload:

1. **`files.csv`** — uploads all thumbnail images to Shopify Files. Each row downloads the image from `Link` URL and stores it under `File Name`.
2. **`articles.csv`**, **`recipes.csv`**, **`herbarium.csv`** — in any order. Each blog post references its thumbnail by `File Name` from step 1.

> ⚠️ If you import a Blog Posts CSV before the Files CSV, the `Metafield: sga.thumbnail [file_reference]` column will fail to resolve the file (because the file doesn't exist yet). Always Files first.

> **Alternative**: combine all 4 sheets into a single Excel `.xlsx` workbook (sheet names: `Files`, `Blog Posts`). Matrixify processes sheets in the correct order automatically.

---

## CSV format conventions (Matrixify)

### File format
- **Encoding**: UTF-8 (with or without BOM)
- **Delimiter**: comma (`,`)
- **Quoting**: double quotes (`"`) — required for values containing commas, line breaks or quotes. Escape inner `"` by doubling them (`""`).
- **Header row**: must match the template exactly. Column names are case-sensitive.

### `Command` column (every Blog Posts row)
Always `MERGE` (default) — updates an existing post matched by Handle, or creates a new one.

Other supported values: `NEW`, `UPDATE`, `REPLACE`, `DELETE`, `IGNORE`. See [Matrixify Commands docs](https://matrixify.app/documentation/list-of-commands-across-matrixify-sheets).

### `Tags Command` column
- `REPLACE` (recommended) — replaces all existing tags with the value from this row.
- `MERGE` — adds the listed tags to existing ones.

### `Tags` column
Comma-separated list of tag strings inside a single cell (quoted because of inner commas).
Example: `"vanoce, peceni, tycinky"`

### `Published` column
`TRUE` / `FALSE` (also accepted: `yes` / `no` / `1` / `0`).

### `Published At` column
ISO 8601 datetime: `2023-04-15T10:30:00Z` (recommended) or shorter forms accepted by ISO.

### `Image Src` (article hero image)
Public URL of the hero image. Matrixify downloads it and uploads to Shopify automatically. No pre-upload needed.

Example: `https://cdn.example.com/articles/med-hero.jpg`

### `Blog: Handle` column
Identifies which blog the post belongs to. Allowed values:
- `news` (for `articles.csv`)
- `recipes` (for `recipes.csv`)
- `herbarium` (for `herbarium.csv`)

Matrixify creates the blog automatically if it doesn't exist.

---

## Metafield columns

Header format: `Metafield: <namespace>.<key> [<type>]`

Our namespace is **`sga`** for all migration metafields.

### Value formats per Matrixify type

| Type | Example value (cell content) |
|---|---|
| `single_line_text_field` | `Mohlo by vás také zajímat` |
| `number_integer` | `90` |
| `list.single_line_text_field` | `"vegan, vegetarian, bezlepkovy"` or JSON array `["vegan","vegetarian"]` |
| `product_reference` | Shopify **product ID** (single value, e.g. `15821921386830`) |
| `list.product_reference` | Comma-separated Shopify product IDs (e.g. `"15821907624270, 15821921386830"`) or JSON array |
| `article_reference` | Article **handle** (the URL slug, e.g. `cokoladove-grissini`) |
| `list.article_reference` | Comma-separated article handles (e.g. `"polevka-z-korenove-zeleniny, kouzelna-cokoladova-pena"`) |
| `file_reference` | File name with extension (e.g. `cokoladove-grissini-thumb.jpg`) — must exist in Shopify Files (uploaded via `files.csv` first) |

> **List values containing commas in actual content**: prefer JSON array syntax to avoid ambiguity. Example for ingredients:
> ```
> ["150|g|pšeničné mouky","1|lžička|soli, mletého pepře","2||vejce"]
> ```

### Ingredients — single metafield, pipe-delimited lines

The **non-product** ingredient lines live in **one** metafield `sga.ingredients` (the old
per-section `sga.ingredients_<N>` + `sga.ingredients_<N>_heading` model is retired — section
headings are no longer migrated). The cell is a JSON array of lines, each `qty|unit|label`
(exactly two pipes):

```
["150|g|pšeničné mouky","1|lžička|Ayurvédská kouzelná sůl","5|ks|mrkve","||olej na zředění","0.5|lžička|pomerančové kůry"]
```

- `qty` — leading number as a decimal (`1/2` → `0.5`); empty if none.
- `unit` — measurement unit if the token after the number is a known unit; empty otherwise.
- `label` — the rest of the ingredient name.

**Product-linked ingredient lines are EXCLUDED from `sga.ingredients`** — they appear only in
`sga.ingredient_products`. Product references are never embedded in the text (no `[[…]]`). The
`sga.ingredient_products` cell is comma-separated Shopify product **handles** (from
`products-mapping.csv`), so a production import resolves them by handle even though many are
absent from the rebuilt dev store.

---

## Reference identifier rules

| Reference target | Identifier to use | Lookup source |
|---|---|---|
| **Products** (`main_product`, `related_products`, `found_in_blends`) | Shopify **product ID** | `products-mapping.csv` |
| **`ingredient_products`** (exception) | Shopify product **handle** | `products-mapping.csv` (`shopify_product_handle`) |
| **Blog posts** (`related_articles`, `you_might_also_like`) | Source **handle** | The URL slug from the old store, e.g. `https://www.sonnentor.com/cs-cz/recepty-a-tipy/recepty/cokoladove-grissini` → `cokoladove-grissini` |

Note: blog posts being migrated don't exist in Shopify yet — they're being CREATED by this import. Matrixify resolves article references by handle within and across blog handles.

---

## Common columns (all 3 Blog Posts CSVs)

| Column | Required | Description |
|---|---|---|
| `Handle` | yes | URL slug (kebab-case, ASCII). Used as primary key — must be unique. |
| `Command` | yes | `MERGE` |
| `Title` | yes | Post title shown on the detail page |
| `Author` | no | Defaults to "Sonnentor" if empty |
| `Body HTML` | recipes: empty; others: yes | Article content as HTML. **Recipes leave empty** — content is rendered from metafields by the theme. |
| `Summary HTML` | no | Short description (~1-2 sentences), shown in card lists |
| `Tags` | no | Comma-separated tags in a single cell, e.g. `"med, zdravi"` |
| `Tags Command` | yes | `REPLACE` |
| `Published` | yes | `TRUE` / `FALSE` |
| `Published At` | yes | Original publication date (ISO 8601) |
| `Image Src` | no | Hero image URL — Matrixify downloads automatically |
| `Image Alt Text` | no | Alt text for the hero image |
| `Blog: Handle` | yes | One of `news` / `recipes` / `herbarium` |
| `Metafield: sga.thumbnail [file_reference]` | no | Filename of the polaroid thumbnail (uploaded via `files.csv`) |

### Article-specific metafields (`articles.csv`)

| Column | Description |
|---|---|
| `Metafield: sga.related_products [list.product_reference]` | Products mentioned in the article. Comma-separated Shopify IDs. |
| `Metafield: sga.related_articles [list.article_reference]` | "Related articles" carousel — comma-separated article handles |
| `Metafield: sga.you_might_also_like [list.article_reference]` | "You might also like" carousel |
| `Metafield: sga.you_might_also_like_heading [single_line_text_field]` | Original heading text of the "you might also like" section |
| `Metafield: sga.related_products_heading [single_line_text_field]` | Original heading text of the related-products section |

### Recipe-specific metafields (`recipes.csv`)

| Column | Description |
|---|---|
| `Metafield: sga.total_time_minutes [number_integer]` | Total prep + cook time in minutes |
| `Metafield: sga.servings [number_integer]` | Number of servings |
| `Metafield: sga.dietary [list.single_line_text_field]` | Dietary tags. Allowed values: `vegan`, `vegetarian`, `bezlepkovy`, `bez-laktozy`, `raw`, `bez-cukru` |
| `Metafield: sga.main_product [product_reference]` | The single main product (Shopify product ID) |
| `Metafield: sga.related_products [list.product_reference]` | Additional products |
| `Metafield: sga.related_articles [list.article_reference]` | Related recipe handles |
| `Metafield: sga.you_might_also_like [list.article_reference]` | "Recipes you might also enjoy" |
| `Metafield: sga.you_might_also_like_heading [single_line_text_field]` | Section heading |
| `Metafield: sga.related_products_heading [single_line_text_field]` | Section heading |
| `Metafield: sga.ingredients [list.single_line_text_field]` | **Non-product** ingredient lines in page order, JSON array of `qty\|unit\|label` lines (no section headings, no `[[…]]` markers; product-linked lines excluded). See "Ingredients" above. |
| `Metafield: sga.ingredient_products [list.product_reference]` | Buyable products referenced by the ingredients (the lines excluded from `sga.ingredients`) — comma-separated Shopify product **handles**. |
| `Metafield: sga.eyebrow [single_line_text_field]` | Category kicker above the title (recipe's first category). Empty if none. |
| `Metafield: sga.serving_tip [single_line_text_field]` | Serving/plating tip, scraped from the legacy recipe's tip block where present (~154 recipes); empty otherwise. |
| `Metafield: sga.difficulty [single_line_text_field]` | Difficulty label. Not present on the legacy site — left empty for migrated recipes. |
| `Metafield: sga.instructions [list.single_line_text_field]` | Recipe steps as JSON array. Plain text, no step numbers (theme adds them). |

### Herbarium-specific metafields (`herbarium.csv`)

| Column | Description |
|---|---|
| `Metafield: sga.latin_name [single_line_text_field]` | Latin name (e.g. `Zingiber officinale`) |
| `Metafield: sga.related_products [list.product_reference]` | Products that contain this plant |
| `Metafield: sga.found_in_blends [list.product_reference]` | Blend products where this plant is an ingredient |
| `Metafield: sga.found_in_blends_heading [single_line_text_field]` | Section heading |

---

## Files sheet (`files.csv`)

Used to bulk-upload thumbnail images **before** importing blog posts.

| Column | Description |
|---|---|
| `File Name` | Target filename in Shopify (with extension). Match this exactly in `Metafield: sga.thumbnail [file_reference]` columns later. |
| `Command` | `MERGE` (create or update) |
| `Link` | Source URL — Matrixify downloads from here |
| `Alt Text` | Alt text for the image |
| `Type` | Always `IMAGE` for our use case |

---

## Validation status

This template structure has been validated against the live Matrixify API (via the Matrixify MCP server) — Matrixify correctly identifies the entity as `Blog Posts`, recognizes all 15 metafield columns in `recipes.csv`, and parses without errors or warnings.

---

## Pre-submission checklist

- [ ] Every `Handle` is unique within the file
- [ ] `Published` is `TRUE` or `FALSE`
- [ ] `Published At` is a valid ISO 8601 datetime
- [ ] `Body HTML` is valid HTML; inner `"` characters are doubled (`""`) inside CSV cells
- [ ] `Image Src` URLs are publicly accessible
- [ ] All thumbnails referenced in `Metafield: sga.thumbnail [file_reference]` have corresponding rows in `files.csv`
- [ ] All **product** references use Shopify product IDs from `products-mapping.csv`
- [ ] All **article** references (`related_articles`, `you_might_also_like`) use source handles
- [ ] Lists containing commas inside values use JSON array syntax `["a, with comma","b"]`
- [ ] `Tags Command` is set on every row (recommended: `REPLACE`)

---

## Questions

For any questions about field mapping, special cases or missing data, please contact **Sounds Good Agency** before submitting.
