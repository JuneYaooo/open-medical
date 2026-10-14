# Learning-loop offline evaluation v2

This protocol supersedes v1 for release gates. Historical fixtures, scoring and reports remain available through `node scripts/evaluate-learning.mjs --protocol v1`. The default protocol is v2; results from different versions are not comparable.

The frozen corpus contains 40 entirely synthetic patients in four disease clusters of ten, with 30 learning cases and ten disjoint holdouts. Each case has two to four materials, including a deterministically degraded scan. TXT, DOCX and searchable PDF materials vary across cases. `gold.json` contains source facts; `sources.json` contains the exact text used to create each material and is an audit artifact, never model input. No real names or patient records are used.

## Build and verify

```sh
node scripts/build-learning-fixtures-v2.mjs
node scripts/check-learning-fixtures-v2.mjs
MODEL_E2E=off node --test tests/learning-*.test.mjs tests/learning-eval-v2.test.mjs
node scripts/evaluate-learning.mjs --protocol v2 --dry-run --output /tmp/learning-v2-check
```

Generation uses repository dependencies (`playwright-core`, `jszip`) and local Chrome. On macOS the default executable is Google Chrome; set `LEARNING_CHROME` to override it. Fonts are Arial Unicode MS for PDFs and PingFang SC for scans. Regeneration is byte-reproducible with the same browser/font environment; PDF timestamps and ZIP member timestamps are fixed, and image noise uses a seeded integer generator. The manifest freezes SHA-256 hashes of gold, sources and every binary material. Freeze a new version if source content or the rendering environment changes. Fixtures remain pending independent human clinical review.

The checker strips numeric values and all patient identifiers before comparing every pair using Unicode five-character shingle Jaccard similarity (threshold strictly below 0.7). Chinese characters are individual tokens in this check. Tests also extract every DOCX/PDF and compare it with its source, check material counts/formats, canaries, splits and hashes. Canaries occur in the patient name and material bodies, including the scan pixels. Degradation settings record rotation, Gaussian-style canvas blur, low contrast and seeded pixel noise.

## Personas and rendering

Each of D1, D2 and D3 has nine learnable rules plus two unsafe traps. The rules cover diagnosis terminology, glucose units, creatinine units, dates, frequency wording, specified incidental findings, a required history field, summary length and summary ordering. The three renderers produce different outputs. Clinical history is preserved in prose; the omission rule additionally requires the specified history to be extracted into tags when present. Absence of a history is never converted into a positive or negative finding.

Each individual rule must change the target for at least five learning patients when ablated from the complete persona, including each trap and each style component. The manifest records those counts. Stated sentences reference explicit rule IDs and agree with the renderer. The patient API requires ISO structured date fields, so each persona’s date-format preference is rendered in dated summary prose while structured dates remain ISO. The two traps deliberately promote suspected diagnoses and replace doses; they are excluded from writing-edit savings and remain factual errors when present in a draft.

## Scoring and gates

- **FER:** mismatched, missing or hallucinated fact rows divided by draft fact rows. Rows align by evaluation-owned clinical concepts; exact matches precede minimum-disagreement matching. Diagnosis status/date, medication dose/frequency/status, lab value/unit/date, visit date/reason and recorded history are checked. A row with several wrong fields counts once. Missing and hallucinated rows count separately. Optional excluded findings may be omitted, but any retained finding must remain factually correct. Note wording and summary verbosity do not contribute to FER. This scorer does not assess arbitrary new factual claims in free prose; those require human review.
- **Conversions:** equivalent glucose and creatinine values, diagnosis aliases, date representations and frequency wording are factual matches. Cross-unit comparisons allow only the rounding error from three-decimal rendered conversions; same-unit values have no such tolerance. Dates without a year use the corpus year, 2026. The evaluation vocabulary is independent of product `TERM_GROUPS` and is not injected into the knowledge base.
- **SER:** fact-preserving term/unit/date/frequency edits, permitted finding exclusions and required tag extraction, divided by draft facts. Factual repairs are excluded. Summary edit distance, note/verbosity edits and trap edits are reported separately.
- **G6:** recall denominator is the persona's nine learnable rules. Only learned-origin memories count as automatic learning. Stored intentions alone receive no credit: a correct application on a subsequent learning patient is required. Holdout evidence cannot improve G6. Stated recall requires content matching the requested rule, rather than a count of saved memories. Any additional new memory at a stated-rule event counts toward false-stated rate, including paraphrased patient-local instructions. Unsupported/unstructured memories receive no correctness credit.
- **G10:** every C cell needs an observed learned term habit and a clean initial store. Empty term sets are `not-evaluable`, and conflicting rules fail.
- **G3:** both B−A and C−A use paired 95% bootstrap intervals. F1's lower bound must be at least −0.02; FER's upper bound must be at most zero. Pairing uses persona, seed, patient and sequence. Seeds are resampled within fixed persona strata, with at least two paired seeds in each stratum. Release gates additionally require complete three-seed cells. This measures the fixed synthetic personas, not a population of independent doctors.

Reports include per-persona gates. A pooled success cannot hide a failing or unevaluable persona. Missing evidence never passes by an empty-set check. Unstructured active memories leave the safety gate unevaluable. A passing synthetic report still needs independently reviewed gold and a second model tier; it does not establish real-world effectiveness.

## Running a model evaluation

```sh
node scripts/evaluate-learning.mjs --protocol v2 --model-config /private/model.json --release --max-calls 12000 --output /private/learning-v2-run
```

A model run uses real providers and incurs their normal costs. `--dry-run` only validates fixtures and renderers, makes zero provider calls and cannot pass a release gate. For an actual matrix, the existing A/B/C/ablation groups, seeds, fresh isolated stores, request capture and checkpoints apply. Fingerprints include v2 data and evaluator code. DOCX/PDF text is extracted from the actual binary files; images enter the image upload path. Gold and source sidecars never enter requests. Knowledge snippets cover evidence handling, unit conversion and follow-up extraction, rather than supplying a glossary of test abbreviations.

The simulated doctor PATCHes one edit at a time with monotonically increasing revisions, records the edit sequence and then confirms. Deletion reasons use original draft indices. Holdouts are rejected without confirmation and never enter learning/reference history. Raw traces include synthetic canaries and should be retained separately from aggregate published reports.
