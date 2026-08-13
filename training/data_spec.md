# NexGen Training Data Specification

This document specifies the format, scope, and quality bar for the dataset
used to fine-tune the NexGen model. It's written to be handed to a data
team, a contractor, or used as your own checklist.

## 1. Record format

One JSON object per line (`.jsonl`). Each record is a single training
example:

```json
{
  "id": "nexgen-clinical-000412",
  "domain": "clinical",
  "system": "You are NexGen, an AI assistant. Provide clinician-grade responses: cite guidelines where relevant, use correct medical terminology, and always recommend professional clinical judgement for actual patient care.",
  "messages": [
    {"role": "user", "content": "What's the first-line treatment for HFrEF?"},
    {"role": "assistant", "content": "For heart failure with reduced ejection fraction (EF <40%), first-line guideline-directed medical therapy (ESC 2021 / ACC-AHA 2022) combines four drug classes, often called the 'four pillars': an ACE inhibitor/ARNI, a beta-blocker, a mineralocorticoid receptor antagonist, and an SGLT2 inhibitor. ARNI (sacubitril/valsartan) is generally preferred over ACE inhibitors where tolerated, based on the PARADIGM-HF trial. This is general clinical information, not a substitute for individualised care from a treating physician."}
  ]
}
```

Required fields: `id`, `domain`, `messages`. `system` is optional but
recommended per-domain (it's what gives each mode — clinical, code, mining
safety, etc. — its distinct behaviour). `messages` must alternate
`user`/`assistant` and end on an `assistant` turn. Multi-turn examples are
supported and encouraged (don't make everything single-turn Q&A).

Optional field: `review_status`. Use this on any record in a safety-
critical domain (clinical, mining_safety, aviation, etc.) that hasn't yet
been signed off by a qualified domain expert — e.g.
`"review_status": "draft - needs domain expert review before production use"`.
Strip the field once a real subject-matter expert has reviewed and
approved the record. The 48-record sample set in `sample_data/` flags its
clinical and mining-safety examples this way since they were drafted for
format reference, not reviewed by a clinician or mining safety engineer —
don't train a production model on them as-is.

## 2. Domain coverage

Match this to whatever the product actually claims to do. The sample set
now spans 14 domains rather than just mining/clinical, reflecting a
general-purpose assistant with deep verticals layered on top:

| Domain | Notes |
|---|---|
| General chat | Open-domain Q&A, everyday reasoning |
| Code | Multiple languages, debugging, infra |
| Extended reasoning | Logic, estimation, multi-step problems with shown work |
| Mathematics | Algebra, geometry, calculus, number theory — show full derivations |
| Statistics | Concepts, common misinterpretations, assumptions/limitations |
| Physics | Mechanics, thermodynamics, modern physics fundamentals |
| Life sciences | Biology, genetics, molecular/cell biology |
| Engineering | Materials, structures, thermodynamics, electrical — flag licensed-engineer sign-off where relevant |
| Clinical / healthcare | Always include the "not a substitute for clinical judgement" framing; never train on real patient data |
| Legal & court systems | Always include "general information, not legal advice"; never train on real case-specific advice |
| Art & culture | Art history, literary forms, cultural/oral traditions across global regions, not just Western canon |
| Finance | Always include "general/educational, not personalized financial advice"; conceptual explanations, not specific investment recommendations |
| Environmental science | Climate, ecology, energy — distinguish established science from active research |
| History | Note where genuine historiographical debate exists rather than presenting one narrative as settled fact |
| Mining / industrial safety | Procedural/safety-critical answers should be conservative and cite the relevant standard where possible |
| Tool use / agentic | Function-calling traces, multi-step task decomposition |
| Refusals / safety | Examples of declining unsafe requests gracefully — this category is easy to skip and shouldn't be |

This list isn't exhaustive — extend it to whatever verticals your actual
product targets (finance, environmental science, history, etc. all
follow the same pattern: a domain-specific `system` prompt, accurate
worked examples, and an appropriate disclaimer for any domain where bad
information has real-world consequences). `build_dataset.py` is
structured so adding a new domain is: add an entry to the `SYS` dict,
write a handful of `rec(...)` calls, done.

## 3. Sourcing — what's actually usable

- **Do not** scrape copyrighted text, other models' outputs in violation of
  their terms of service, or any dataset whose license forbids commercial
  fine-tuning. Check the license of every source dataset against your
  intended use before including it.
- **Do not** include real patient records, real customer PII, or anything
  under an NDA without an explicit data-sharing/processing agreement
  covering model training.
- Legitimate sources: data you're permissively licensed to use, data you
  generate in-house (subject matter experts writing/reviewing Q&A pairs),
  permissively-licensed public instruction datasets (check license terms
  per-dataset), and synthetic data generated and *reviewed* by domain
  experts (don't ship unreviewed synthetic data for safety-critical
  domains like clinical or mining safety — errors there have real
  consequences).

## 4. Quality bar

- **Deduplication**: near-duplicate detection (e.g. MinHash/LSH) before
  training; duplicated examples bias the model toward memorising phrasing
  rather than generalising.
- **PII scrubbing**: run a PII detector over every record; redact or
  discard records that fail.
- **Length distribution**: avoid a dataset that's 90% short Q&A — include
  longer multi-turn and longer-output examples or the model will default
  to terse responses regardless of what's asked.
- **Expert review for safety-critical domains**: every clinical, mining
  safety, and aviation example should be reviewed by someone qualified in
  that domain before inclusion. This isn't optional — it's the difference
  between a useful assistant and a liability.
- **Held-out eval set**: reserve 5-10% of data (by topic, not just random
  split, to catch true generalisation) as `eval_example.jsonl` / your real
  eval file. Never let eval examples leak into training.

## 5. Scale guidance

| Goal | Approx. examples needed |
|---|---|
| Narrow persona/style adjustment on a strong base model | 500 - 2,000 |
| Solid multi-domain assistant (what this product needs) | 10,000 - 50,000 |
| Strong domain specialisation (e.g. clinical-grade) | 50,000+ *reviewed* domain examples |

These are realistic fine-tuning scales — nowhere close to the 15-trillion-
token pretraining corpus implied by the marketing copy's "1.8T parameter"
claim. That's the actual difference in scope: pretraining builds raw
capability from trillions of tokens of general text; fine-tuning takes an
already-capable open base model and steers it. The numbers above are for
the steering step, which is what's actually achievable here.

## 6. Evaluation

Don't rely on internal self-reported benchmark numbers in production
marketing copy unless you've actually run them. If you want comparable
numbers, run your fine-tuned model against real public benchmarks
(MMLU, GSM8K/MATH, HumanEval, MedQA, etc.) using their standard public
eval harnesses, and report only what you actually measured.
