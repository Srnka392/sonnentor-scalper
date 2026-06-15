# Sonnentor → Shopify Migration: Column Guide

Where to find each column's data on the legacy sonnentor.com store.

## Files to fill

| File | What it holds | Old store section |
|---|---|---|
| `articles.csv` | Tips & advice articles | `/recepty-a-tipy/rady-a-tipy/...` |
| `recipes.csv` | Recipes | `/recepty-a-tipy/recepty/...` |
| `herbarium.csv` | Plants & spices | `/herbar/...` |
| `files.csv` | Thumbnail images (uploaded once, referenced by name) | — |

Helper file `products-mapping.csv` is for **lookup only** — do not edit.

---

# Common columns (all 3 Blog Posts files)

## `Handle`
Last URL segment of the page.
- URL: `/recepty-a-tipy/recepty/cokoladove-grissini` → `cokoladove-grissini`

> [Screenshot: detail page URL bar with last segment highlighted]

---

## `Command`
Always set to `MERGE`. No exceptions.

---

## `Title`
The H1 / page title shown on the detail page.

> [Screenshot: H1 title on the article detail page]

---

## `Author`
Always `Sonnentor` (leave empty to default to Sonnentor).

---

## `Body HTML`
Full article body as HTML — only headings, paragraphs, lists, links and images. Do **not** include the H1 title (it lives in `Title`).

Keep links to products as `<a href="/eshop/<source-handle>">...</a>` — we'll rewrite them on import.

**Recipes**: leave empty. The recipe page is rendered entirely from metafields.

> [Screenshot: article body content area, with H1 excluded]

---

## `Summary HTML`
Short intro / lead paragraph shown in card lists. Plain text or single `<p>`.

Source on the legacy site: either the "perex" / lead paragraph above the article body, or the first sentence of the body if no perex exists.

> [Screenshot: lead paragraph location]

---

## `Tags`
Tags shown at the bottom of the detail page, comma-separated in one cell.
- Example: `"med, zdravi, kucharka"`

> [Screenshot: tag list at the bottom of an article]

---

## `Tags Command`
Always set to `REPLACE`.

---

## `Published`
`TRUE` if the article is publicly visible on the legacy site, `FALSE` if it was hidden / unpublished.

---

## `Published At`
Original publication date in ISO 8601: `2023-04-15T10:30:00Z`. Date-only also works: `2023-04-15`.

Source: created / first-published timestamp in Pimcore. If only the date is known, use the date.

---

## `Image Src`
Public URL of the **hero image** — the large image at the top of the detail page. Matrixify downloads it automatically.

> [Screenshot: hero image at top of article detail page]

---

## `Image Alt Text`
Alt text of the hero image (often equals the article title).

---

## `Blog: Handle`
Which Shopify blog the post belongs to. **Fixed per file:**

| File | `Blog: Handle` value |
|---|---|
| `articles.csv` | `news` |
| `recipes.csv` | `recipes` |
| `herbarium.csv` | `herbarium` |

---

## `Metafield: sga.thumbnail [file_reference]`
File name (with extension) of the **polaroid thumbnail** image — the smaller card-format image used in carousels and lists. The thumbnail is a *different* image (different aspect ratio) than the hero in `Image Src`.

- Value must match a `File Name` from `files.csv`
- Example value: `cokoladove-grissini-thumb.jpg`

> [Screenshot: polaroid thumbnail on a card/list page — NOT the hero]

---

# `articles.csv` — extra columns

## `Metafield: sga.related_products [list.product_reference]`
Products linked from the article body or in the "products" box on the page. Comma-separated **Shopify product IDs** (look up in `products-mapping.csv`).
- Example: `"15821907624270, 15821921386830"`

> [Screenshot: in-article product box / linked products]

---

## `Metafield: sga.related_articles [list.article_reference]`
Articles shown in the "Related articles" carousel on the detail page. Comma-separated **article handles** (the URL slug).

> [Screenshot: "Related articles" carousel]

---

## `Metafield: sga.you_might_also_like [list.article_reference]`
Articles in the "You might also like" carousel — usually at the bottom of the page.

> [Screenshot: "You might also like" carousel]

---

## `Metafield: sga.you_might_also_like_heading [single_line_text_field]`
Original heading text of the "you might also like" carousel (e.g. `Mohlo by vás také zajímat`).

---

## `Metafield: sga.related_products_heading [single_line_text_field]`
Original heading text of the related-products box (e.g. `V chladných dnech oceníte silné pomocníky`).

---

# `recipes.csv` — extra columns

## `Metafield: sga.total_time_minutes [number_integer]`
Total prep + cook time in **minutes**. Convert "1h 30min" → `90`.

> [Screenshot: time indicator on recipe page]

---

## `Metafield: sga.servings [number_integer]`
Number of servings. Plain integer.

> [Screenshot: servings indicator on recipe page]

---

## `Metafield: sga.dietary [list.single_line_text_field]`
Dietary tags. Comma-separated. **Allowed values only:**
`vegan`, `vegetarian`, `bezlepkovy`, `bez-laktozy`, `raw`, `bez-cukru`

> [Screenshot: dietary icons/badges on recipe page]

---

## `Metafield: sga.main_product [product_reference]`
The single **main product** for the recipe (one Shopify product ID).

> [Screenshot: main product highlighted on recipe page]

---

## `Metafield: sga.related_products [list.product_reference]`
Other products used in the recipe — comma-separated Shopify IDs.

---

## `Metafield: sga.related_articles [list.article_reference]`
"Related recipes" carousel — comma-separated recipe handles.

---

## `Metafield: sga.you_might_also_like [list.article_reference]`
"Recipes you might also enjoy" carousel — comma-separated recipe handles.

---

## `Metafield: sga.you_might_also_like_heading [single_line_text_field]`
Heading text of that carousel.

---

## `Metafield: sga.related_products_heading [single_line_text_field]`
Heading text of the products section on the recipe page.

---

## `Metafield: sga.ingredients [list.single_line_text_field]`
The recipe's **non-product** ingredient lines, in page order, as a single **JSON array**.
Section headings are **not** migrated — every plain ingredient (across all of the recipe's
original sections) goes into this one list, in the order they appear on the page.

**Product-linked lines are EXCLUDED from this list.** Any ingredient that references a buyable
product belongs solely in `sga.ingredient_products` (below) and does **not** appear here. So a
recipe whose page listed `5 ks mrkve`, `1 ks zázvoru`, `olej na zředění`, `Pepř černý` (a
product), `1 lžička medu`, and three more products yields just the four non-product lines:
`["5|ks|mrkve","1|ks|zázvoru","||olej na zředění","1|lžička|medu"]`.

Each line is **pipe-delimited** `qty|unit|label` — exactly three fields, two pipes:

| Field | Meaning |
|---|---|
| `qty` | Leading numeric quantity as a decimal. Fractions are converted (`1/2` → `0.5`, `1/8` → `0.125`). Empty if the line has no leading number. |
| `unit` | The measurement unit right after the number (`ks`, `g`, `kg`, `l`, `ml`, `lžíce`, `lžička`, `hrnek`, `špetka`, `balení`, `stroužek`, …). Empty if there is none. |
| `label` | The remaining ingredient name. |

Rules:
- Quantities/units are split off **only** when the leading token is clearly numeric and
  (for the unit) the next token is a known unit. Otherwise everything stays in `label`
  with empty `qty`/`unit` (e.g. `2 vejce` → `2||vejce`, `olej na zředění` → `||olej na zředění`).
- Product references are **not** embedded here — no `[[…]]` markers, and a product-linked line
  is dropped entirely (it lives only in `sga.ingredient_products`). This column carries the
  non-product lines only.

```
["150|g|pšeničné mouky","1|lžička|Ayurvédská kouzelná sůl","5|ks|mrkve","||olej na zředění","0.5|lžička|pomerančové kůry"]
```

> [Screenshot: ingredient list on recipe page]

---

## `Metafield: sga.ingredient_products [list.product_reference]`
The buyable products referenced by the recipe's ingredients — comma-separated Shopify product
**handles** (the `shopify_product_handle` column of `products-mapping.csv`). These are the
ingredient lines that were **excluded** from `sga.ingredients`.

Handles (not IDs) are used here on purpose: the export targets the **production** store, where
the products exist under these handles even though many are absent from the rebuilt dev store.
Matrixify resolves `list.product_reference` by handle on import. Empty cell = the recipe linked
no products, or none of them had a row in `products-mapping.csv`.

(Note: the live dev-store metafield write resolves these handles to current dev gids and writes
only the ones that resolve; when none resolve it skips the write so any hand-curated value on a
demo article is preserved. The CSV export above is independent of that and always lists every
mapped handle.)

---

## `Metafield: sga.eyebrow [single_line_text_field]`
Short category kicker shown above the recipe title — the recipe's first category
(`.recipe__categories`) on the legacy page, e.g. `Polévky`, `Světová kuchyně`. Empty if the
recipe has no category.

---

## `Metafield: sga.serving_tip [single_line_text_field]`
A serving / plating tip, scraped from the legacy recipe's tip block (`.tip-item__text`)
where present — populated for ~154 recipes, empty for the rest. Single line (tips joined
with a space when a recipe has more than one tip block).

---

## `Metafield: sga.difficulty [single_line_text_field]`
Recipe difficulty label (e.g. `Snadné`). **The legacy recipe page has no difficulty field**,
so this is left empty for migrated recipes (column exists for future editorial use).

---

## `Metafield: sga.instructions [list.single_line_text_field]`
Cooking steps. **JSON array.** Plain text, no numbering (the theme adds step numbers).

```
["Smíchejte mouku.","Předehřejte troubu na 180 °C.","Vyválejte těsto."]
```

> [Screenshot: numbered cooking steps on recipe page]

---

# `herbarium.csv` — extra columns

## `Metafield: sga.latin_name [single_line_text_field]`
Latin name of the plant (e.g. `Zingiber officinale`).

> [Screenshot: latin name on plant detail page]

---

## `Metafield: sga.related_products [list.product_reference]`
Products containing this plant — comma-separated Shopify IDs.

---

## `Metafield: sga.found_in_blends [list.product_reference]`
Blend / tea products where this plant is an ingredient — comma-separated Shopify IDs.

> [Screenshot: "Found in blends" section on plant detail page]

---

## `Metafield: sga.found_in_blends_heading [single_line_text_field]`
Original heading text of the "Found in blends" section (e.g. `Najdete v směsích`).

---

# `files.csv` — thumbnail upload sheet

One row per thumbnail image. Imported **before** the Blog Posts CSVs.

## `File Name`
Target file name in Shopify, with extension. Must match the value used in `Metafield: sga.thumbnail [file_reference]` of the corresponding Blog Post row.
- Recommended convention: `<handle>-thumb.jpg`
- Example: `cokoladove-grissini-thumb.jpg`

## `Command`
Always `MERGE`.

## `Link`
Public URL of the thumbnail image on the legacy CDN. Matrixify downloads it.

## `Alt Text`
Alt text for the image (often the article title).

## `Type`
Always `IMAGE`.

---

# Reference identifier rules (quick lookup)

| Reference target | Identifier | Where to look up |
|---|---|---|
| **Products** (`product_reference` / `list.product_reference` metafields) | Shopify product **ID** | `products-mapping.csv` |
| **`sga.ingredient_products`** (exception) | Shopify product **handle** (`shopify_product_handle`) | `products-mapping.csv` |
| **Articles / recipes / herbs** (`related_articles`, `you_might_also_like`) | Source **handle** (URL slug) | The URL on the legacy site |

---

# Final notes

- All list cells: comma-separated, or JSON array if values may contain commas
- Quoting: wrap any cell with commas/newlines/quotes in `"..."`, double inner quotes as `""`
- Empty cell = no value
- One row per article — multiple rows per article only for blog post comments (we are not migrating comments)
