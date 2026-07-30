# Bangkok Wine Scout event pipeline

## Processing flow

```text
LINE image
  ↓
R2 original image
  ↓
metadata.json
  ↓
ocr.json
  ↓
event.json
  ↓
event-normalized.json
```

## Normalization layers

`event.json` is the structured Workers AI extraction result. It may still contain OCR spelling errors and presentation-specific formatting.

`event-normalized.json` is the stable downstream representation. The event normalizer currently handles:

- date formatting
- numeric THB prices
- email and phone extraction
- wine entity normalization

## Phase 2.6: Wine Entity Normalizer

Implementation: `src/services/wine-normalizer.ts`

Each extracted wine name is retained as evidence in `raw` and compared with a curated reference list. Matching is deterministic and does not require another Workers AI request.

Matching order:

1. canonical exact match after case, accent, punctuation, and whitespace normalization
2. known OCR alias
3. conservative fuzzy match with a minimum similarity of `0.82`
4. unchanged fallback for unknown names

Example:

```json
{
  "raw": "Château Toumeufeuille",
  "normalized": "Château Tournefeuille",
  "confidence": 0.94,
  "matchType": "alias"
}
```

The `wines` property in `event-normalized.json` is now an array of these objects. Unknown names are preserved with `matchType: "unmatched"` so future reference-data updates can reprocess them without losing the original extraction.

## Extending the reference data

Add a canonical producer or wine and its observed OCR variants to `WINE_REFERENCES` in `src/services/wine-normalizer.ts`. Only verified aliases should be added. The fuzzy threshold should remain conservative to avoid silently mapping different estates to one another.
