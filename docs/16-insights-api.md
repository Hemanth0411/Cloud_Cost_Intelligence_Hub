# `GET /insights` — narrated insights

Written for whoever wires the `/insights` screen. It replaces the
client-side generator in `frontend/src/lib/insights/`: the figures come
from the API, scoped by the caller's grants, and each card may carry one
sentence about those figures.

Two rules to build the screen around:

> **Figures are always there. Prose is optional.** A card with
> `text: null` is a complete, correct card. Never fill the gap with
> generated or templated text on the client — show the figures, and say
> plainly that the sentence is unavailable.

> **Say what the model does.** It does not write the sentences. The
> backend writes them; a model on Amazon Bedrock chooses which wording
> to show and which card to lead with. "Wording selected by AI" is true.
> "Written by AI" is not.

---

## Request

```
GET /insights
Authorization: Bearer <cognito-jwt>
```

| Query | Default | Meaning |
|---|---|---|
| `end` | the last **final** day: three days ago (UTC) | Inclusive. |
| `start` | 29 days before `end` | Inclusive. At most 366 days, not before 2006. A bad window is a 422. |
| `provider`, `account_id`, `service` | none | Same meaning as on `/cost/*`. |
| `metric` | `effective_cost` | or `billed_cost`. |
| `narrate` | `true` | `false` returns the figures and makes **no model call**. |

The default window does not end yesterday, on purpose: providers restate
the most recent days and ingest runs once a day, so a window ending on an
unfinalised day reads as a fall that is only missing data. The anomaly
detector skips the last two days for the same reason.

The previous period is the immediately preceding window of equal length,
exactly as `/cost/compare` defines it.

**Suggested loading pattern:** call with `narrate=false` first and render
the cards, then call again without it and fill in the sentences. The
figures never wait on a model that way.

## Response

The usual envelope (`data`, `as_of`, `metric`, `currency`,
`partial_period`, `row_count`), plus `windows`, `comparison` and
`narration`. This is a real response from 2026-10-13, trimmed to two of
its six cards:

```json
{
  "data": [
    {
      "id": "top_increase",
      "kind": "top_increase",
      "title": "Largest increase in spend, by service",
      "direction": "up",
      "subject": { "type": "service", "service_name": "Amazon Relational Database Service" },
      "figures": { "current": "1987.50", "previous": "1215.00", "delta_abs": "772.50", "delta_pct": 63.6 },
      "display": {
        "service": "Amazon Relational Database Service",
        "current": "$1,987.50",
        "previous": "$1,215.00",
        "delta_abs": "+$772.50",
        "delta_pct": "+63.6%"
      },
      "text": "Spend on Amazon Relational Database Service in this view rose 63.6%, from $1,215.00 in the previous period to $1,987.50 in the current period."
    },
    {
      "id": "anomaly_1",
      "kind": "anomaly",
      "title": "Unacknowledged anomaly finding",
      "direction": "up",
      "subject": {
        "type": "anomaly", "finding_id": "503b8d2d-247a-4d84-b952-0827a92f8ef7",
        "provider": "aws", "account_id": "111122223333",
        "service_name": "Amazon Relational Database Service",
        "detected_for_date": "2026-10-07", "method": "mad"
      },
      "figures": {
        "baseline": "40.50", "observed": "97.20", "delta_abs": "56.70", "delta_pct": 140.0,
        "anomaly_kind": "step", "per": "day", "metric": "effective_cost", "findings_on_file": 1
      },
      "display": {
        "service": "Amazon Relational Database Service", "account": "account 111122223333",
        "date": "7 Oct 2026", "kind": "step change",
        "baseline": "$40.50 a day", "observed": "$97.20",
        "delta_abs": "+$56.70", "delta_pct": "+140.0%"
      },
      "text": "For Amazon Relational Database Service in account 111122223333, an unacknowledged finding dated 7 Oct 2026 records daily cost as high as $97.20, $56.70 above its baseline of $40.50 a day."
    }
  ],
  "as_of": "2026-10-13T13:42:04.029465Z",
  "metric": "effective_cost",
  "currency": "USD",
  "partial_period": false,
  "row_count": 6,
  "windows": {
    "current":  { "start": "2026-09-11", "end": "2026-10-10" },
    "previous": { "start": "2026-08-12", "end": "2026-09-10" }
  },
  "comparison": {
    "comparable": true,
    "current_days_with_data": 30,
    "previous_days_with_data": 30,
    "days_in_period": 30,
    "accounts_checked": 1,
    "note": null
  },
  "narration": {
    "status": "ok",
    "reason": null,
    "model": "amazon.nova-lite-v1:0",
    "cached": false,
    "stored": true,
    "generated_at": "2026-10-13T13:42:29.108021Z",
    "expires_at": "2026-10-14T13:42:32.448233Z",
    "narrated": 6,
    "withheld": 0,
    "refused": {},
    "lead": "anomaly_1"
  }
}
```

### A card

| Field | Notes |
|---|---|
| `id` | Stable within a response. `anomaly_1`..`anomaly_3` for findings. |
| `kind` | `total_change`, `total`, `top_service`, `top_increase`, `top_decrease`, `new_service`, `account_mover`, `anomaly`. |
| `title` | Where rank is stated ("Largest increase in spend, by service"). Ranked by amount, not percent. |
| `direction` | `up`, `down`, `flat`, or `none` when the card makes no comparison. |
| `subject` | What the card is about: `{type: "total"}`, a `service_name`, an `account_id`, or for an anomaly the `finding_id` (the id `/anomalies` returns) with its account, service, date and method. |
| `figures` | The raw values. **Money is an exact decimal string** (`"772.50"`), as on `/cost/*`; `delta_pct` and `share_pct` are numbers. `delta_pct` is `null` when the previous value is under $1 or the change rounds to 0.0%. |
| `display` | The same figures formatted. Show these beside the text so a reader can check it. |
| `text` | One sentence, or `null`. |

Money is rounded to cents before deltas are taken, so the figures on a
card agree with each other: `current − previous` is exactly `delta_abs`.

**Every amount is "in this view".** The caller's grants and the filters
decide what a total or an account's spend includes, so the sentences say
so rather than claiming a figure for the whole estate. As on the other
cost screens, `Tax` and `Credit` rows are excluded.

Which cards appear depends on the data, and a card is left out whenever
its title could be false:

- `total_change` needs comparable periods (below); otherwise it is `total`.
- Mover cards need a change of at least $1, and a **unique** largest: on
  an exact tie there is no card.
- `top_service` is omitted on a tie, or if any service is net negative (a
  refund), since a share of the total would be meaningless.
- `new_service` means no rows at all in the previous period. If the
  largest such service already has the increase card, there is no second
  card.
- `account_mover` needs two visible accounts and no `account_id` or
  `service` filter.
- Service cards are omitted when a `service` filter is set.
- A caller with no grants — or no data in the window — gets `data: []`.

### Anomaly cards

These read differently from the rest, because the detector's columns do
not mean what their names suggest. The wording follows what
`anomaly/mad.py` stores:

| The sentence says | Because |
|---|---|
| "daily cost **as high as** $97.20" | `observed_value` is the highest single day in the flagged run (or a median that some day reached). It is not a rate that held, and not the cost on the finding's date. |
| "**dated** 7 Oct" | `detected_for_date` is the first flagged day the detector could still see when it ran. For an anomaly that has run for weeks, that is not when it began. |
| "**unacknowledged**" | Nothing closes a finding. `status = 'new'` means nobody has acknowledged it — not that it is still happening. |
| nothing about the kind | `kind` is re-derived nightly from a sliding week and is not stable for one event. It is in `display` as the detector's label, not asserted in the sentence. |

The figures are per **day** (`"per": "day"`), and always
`effective_cost`, which is all the detector reads — so anomaly cards are
omitted when `metric=billed_cost`.

The detector re-scans a trailing week every night, so one long-running
step is on file many times with many dates. Each account-and-service gets
**one** card, for its largest finding, with `findings_on_file` counting
the rest. Only findings from the `mad` detector with a rise are shown.

### `comparison`

A change is reported only when comparing the two periods is sound.
Otherwise the arithmetic is true and the statement is false: flat spend
with yesterday's rows not yet ingested reads as "fell 3.3%"; a newly
connected account reads as "rose from $0.00".

`comparable` is `true` only if **both**:

- the current period ends on or before the last final day; and
- **every account in view was ingested for every day of both periods** —
  successful ingest runs for that account, taken together, cover the
  whole span. Per account, because ingestion is per account and one
  healthy account otherwise hides another's gap.

The ingest log is what is asked, not the cost rows. Zero-cost days are
not stored, so rows cannot tell "nothing was spent" from "nothing was
loaded". An earlier version asked for rows on every day; on the first
real estate it ran against, one account that spent nothing on most days
— and had been ingested end to end — blocked every comparison.

When it is `false`, no card states a change and `note` — a sentence the
backend wrote — says which condition failed, for which account and from
which day. Show it. `accounts_checked` is how many accounts were
verified; above 200 the check is not attempted and no change is reported.

If amounts in more than one currency are in view, **no cards are returned
at all**: the store adds amounts without converting them, so a total
would not be a figure. `note` says to filter to one provider or account.

Known limits, stated rather than hidden:

- A successful ingest run is taken at its word. If a run recorded
  success but loaded only part of its period, the comparison is allowed.
- Completeness is per account, not per service. A service enabled
  partway through the previous period, in an account that was ingested
  throughout, appears as an increase — which is what it is.
- Mixed currencies are detected from the smallest currency code per day
  and per key. Two currencies inside the same account on the same days
  would go unnoticed. AWS data is USD-only; this needs an Azure
  subscription billing one service in two currencies.

### `narration`

| `status` | Meaning | What to show |
|---|---|---|
| `ok` | Every card has a sentence. | The cards. |
| `partial` | Some cards have none; `refused` says which and why. | The cards; those without text show figures only. |
| `unavailable` | No sentences this time; `reason` says why. | Figures only, with a plain notice. |
| `off` | Not requested (`narrate=false`) or switched off server-side. | Figures only. |
| `no_data` | No cards. | The empty state, with `comparison.note` if set. |

`reason` when `unavailable`:

| `reason` | Cause |
|---|---|
| `timeout` | Bedrock did not answer inside the time budget. |
| `throttled` | Bedrock rate limit or quota. |
| `access_denied` | The API's role may not invoke the model (IAM not applied, or the model id and the IAM grant disagree). |
| `model_unavailable` | The model id is not found or not enabled in this account. |
| `bedrock_error`, `bedrock_unreachable` | Bedrock failed or could not be reached. |
| `no_valid_choice` | The model answered, but with nothing usable. |
| `in_progress` | Another request for the same view is making the call right now. Ask again in a few seconds. |
| `budget` | A daily call budget is spent. |
| `cache_unavailable` | The ledger table cannot be read or written, so no call is made. |
| `internal_error` | A bug in narration. Logged; the figures are unaffected. |

After a failure, the same reason is reported for up to 60 seconds without
a new attempt being made.

Other fields: `cached` — the choices came from the ledger. `stored` —
`false` in the rare case an answer was shown but could not be saved.
`generated_at` / `expires_at` — when the choices were made and when they
lapse. `refused` — card id to `not_chosen` (the model gave no valid
choice for it) or `name_withheld`. `lead` — the card the model would show first, or `null`;
an editorial suggestion for ordering or highlighting, not a claim.

---

## What the model does, and why it does not write

It does not compute. `backend/costhub/insights/facts.py` builds the cards
— every read goes through `query/scoped` with the **caller's own
Principal**, so a card can only hold what that caller could already chart
— and does all the arithmetic in `Decimal`. Anomaly cards come from the
same reader as `GET /anomalies`, with the same caller.

It does not write either. `backend/costhub/insights/frames.py` writes a
handful of candidate sentences per card, each true by construction from
that card's figures. The model is shown the cards and their candidates and
answers with this, and only this:

```json
{"choices": {"total_change": 1, "top_increase": 3, "anomaly_1": 2}, "lead": "anomaly_1"}
```

An index that is not an integer in range, or an id that is not one of the
cards, leaves that card without a sentence. Nothing the model returns is
stored or shown except those integers and that id.

**This is the third design, and the history is the argument for it.**

1. *The model wrote sentence templates*, checked by a word allowlist and
   rules about which placeholder could follow which word. A review broke
   it — one ordinary word between a claim and its figure was enough:

   ```
   {service} saw an increase in spend of {current}.
   → Amazon RDS saw an increase in spend of $1,980.00.    (the increase was $769.60)
   ```

   Eight such sentences were reproduced, including wrong signs and wrong
   directions. Free prose cannot be *proven* to be supported by figures,
   only made less likely to be wrong.

2. *The backend wrote the sentences and the model chose.* A second review
   found no way for model text to reach the screen — and found that the
   backend's own sentences could still be false, because of what the data
   meant: a missing day read as a fall, a new account as a rise from zero,
   one anomaly as three, a peak day as a daily rate.

3. *This one* keeps the split and fixes the data: the comparison rules
   above, the anomaly wording, one card per series, "in this view".

The cost is that the sentences are plain and the model's contribution is
editorial — variety of wording, and what to lead with. That is the trade
this feature makes: it would rather say less than say something the
figures do not show.

A service or account name is data from a bill and is printed inside a
sentence, so it is treated with the same suspicion. A name shaped like a
name — every word capitalised or a number — is printed as it is. Anything
else ("EC2 dropped to zero. RDS") is printed in quotation marks so it can
only be read as a name. One that could close those marks early or hide
text gets no sentence (`name_withheld`).

**What is sent to Bedrock:** the caller's own cards and candidate
sentences — service names, account ids and amounts within their grants —
and nothing else. The model is on-demand in `us-east-1`; no cross-region
inference profile is used.

## Model

**Amazon Nova Lite** (`amazon.nova-lite-v1:0`), chosen by what the deploy
account (997916278551) can actually call, checked on 2026-10-13:

| Model | Result |
|---|---|
| Claude — Haiku 4.5, Sonnet, every Anthropic model | **Refused.** The Anthropic use-case form has never been submitted for this account; `aws bedrock get-use-case-for-model-access` confirms it. Appearing in `list-foundation-models` proves nothing — they all do. Two calls succeeded in a brief grace window and then seven of seven were refused. |
| Claude Haiku 5.5 | Refused: "not available for this account". |
| Amazon Nova Micro | Callable, cheaper, and returns valid choices. But in four runs it chose the first candidate most of the time and led with the same card every time — position bias rather than judgment. |
| **Amazon Nova Lite** | Callable. Valid choices on every card in every run, varied wording, and led with the anomaly each time. |

Prices from the AWS Pricing API: Nova Lite $0.06 per million input tokens
and $0.24 per million output; Nova Micro $0.035 and $0.14. A call measured
1,800–2,300 input and 80–90 output tokens: **about $0.00013 per uncached
call** on Lite, $0.00009 on Micro.

To change model, change it in **both** places: `insights_model_id` in
`terraform/iam.tf` and `INSIGHTS_MODEL_ID` on the API function. Until
`terraform/lambda.tf` passes the variable through, they are two settings;
if only the Terraform one moves, every call is denied and the response
says `access_denied`. The line that would tie them together, in the API
function's environment block:

```hcl
INSIGHTS_MODEL_ID = var.insights_model_id
```

To use Claude: submit the Anthropic use-case form in the Bedrock console
(an attestation the account owner makes), wait for it to take effect, then
change the model as above. Claude here is served only through an inference
profile, so the IAM grant needs the profile ARN **and** each destination
region's foundation-model ARN, not one ARN. Nothing else changes: the call
uses the model-agnostic Converse API.

## Cost

`/insights` is a page load, so an uncached endpoint would be a bill.

- **Cache.** The model's choices are stored in Postgres
  (`insight_narrations`) per caller, filters, `as_of`, every displayed
  figure and the candidate sentences. **Lifetime: 24 hours**, or sooner if
  any of those change — a new ingest moves `as_of`. An answer that chose
  for fewer than half the cards is kept 1 hour instead.
- **Only choices are stored** — card ids and integers. Never a figure, a
  name or a sentence. Figures are recomputed on every request, so a
  revoked grant takes effect at once whatever is stored.
- **The ledger is written before the call.** One row per attempt,
  inserted as `pending` before Bedrock is called. That proves the table is
  writable before any money is spent; counts every attempt, including one
  that timed out or was never recorded as finished; and stops a second
  identical request paying for the same answer (`reason: "in_progress"`).
- **Budgets.** `INSIGHTS_DAILY_CALL_BUDGET` attempts per rolling 24 hours
  across all users (default 500, about $0.07 a day), and
  `INSIGHTS_USER_DAILY_CALL_BUDGET` per user (default 100), so one caller
  cycling through date ranges cannot spend everyone's allowance. Past
  either, `reason: "budget"`. The check is read-then-act, so concurrent
  requests can overshoot by a few calls.
- **No ledger, no spend.** If the table cannot be read or reserved in, no
  call is made.

Each call logs `insights: bedrock call model=… input_tokens=…
output_tokens=… latency_ms=… stop=…`, and each ledger row records its
token counts. Rows are pruned after 8 days.

## Failure and timeouts

Bedrock being slow, throttled, denied or down never fails the request.
The response is a 200 with the figures, `text: null` on every card, and
`narration.reason` saying what happened. A cached answer is still served
while Bedrock is down.

API Gateway cuts a request at 29 s and the API Lambda at 30 s. The model
call has a hard budget of its own: 2 s to connect, 5 s to read
(`INSIGHTS_BEDROCK_TIMEOUT_S`, clamped to at most 10), and **one attempt
in total**. When it overruns, the caller gets the figures with
`reason: "timeout"`, and that container does not try Bedrock again for 60
seconds — so an outage costs one slow page load, not every one. A call
that timed out may still be billed; the ledger counts it and the pause
bounds the repeats.

If the whole request were ever cut at 29 s, the browser would get API
Gateway's own 503 and no figures. The budget above is what keeps that
from happening, and the `narrate=false` first-load pattern removes the
risk for the figures entirely.

Measured against Nova Lite: 0.8–1.5 s per call. The first call in a fresh
process is slower because of client start-up. The endpoint also makes
around a dozen small database reads, one of them on the ingest log.

## Configuration

Environment variables on the API function. All optional; a mistyped value
falls back to the default rather than breaking the endpoint.

| Variable | Default | |
|---|---|---|
| `INSIGHTS_ENABLED` | `true` | `false` turns narration off; figures still served. |
| `INSIGHTS_MODEL_ID` | `amazon.nova-lite-v1:0` | Must match `insights_model_id` in `terraform/iam.tf`. |
| `INSIGHTS_BEDROCK_TIMEOUT_S` | `5` | Read timeout, clamped to 1–10. |
| `INSIGHTS_CACHE_TTL_HOURS` | `24` | Cache lifetime, clamped to 1–720. |
| `INSIGHTS_DAILY_CALL_BUDGET` | `500` | Attempts per rolling 24 h, all users. `0` removes the limit. |
| `INSIGHTS_USER_DAILY_CALL_BUDGET` | `100` | Per user. `0` removes the limit. |

None of these is set by Terraform today, so a value changed in the console
survives only until the next apply rewrites the function's environment.

## Deploying it

Three things, and the endpoint degrades honestly until all three are done:

1. `./do.sh migrate dev` — creates `insight_narrations`. Without it:
   `reason: "cache_unavailable"`, and no model call.
2. `terraform apply` — adds `aws_iam_role_policy.insights_bedrock`:
   `bedrock:InvokeModel` on the one model ARN. Without it:
   `reason: "access_denied"`.
3. Rebuild and ship the bundle. `./do.sh up dev` does all three, in order.

Then check it with a real token:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/insights" | python -m json.tool
```

## Open items outside this endpoint's files

Found in review, in files this change did not own:

- **The anomaly detector re-files one event every night.** It dates a
  finding at the first flagged day inside a sliding week and upserts on
  that date, so a continuing step gains a new row daily, and its `kind`
  can change between rows. `/insights` collapses these to one card; the
  `/anomalies` screen shows them all. The fix belongs in
  `anomaly/runner.py`: reuse the open row for a series.
- `routes/anomalies.py` scopes findings with a hand copy of
  `scoped.GRANT_PREDICATE`. It matches today, and `/insights` has a test
  that would notice the service clause drifting, but deriving it from
  `scoped.py` would remove the risk.
- A superadmin reading findings (`GET /anomalies`, and therefore the
  anomaly cards here) leaves no bypass audit row, unlike a superadmin
  reading cost.
- The store sums amounts across currencies without conversion.
  `/insights` refuses to show anything when it can see that; the `/cost/*`
  endpoints do not.
