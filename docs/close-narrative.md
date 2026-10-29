# The morning close, in words

The 04:00 close email opens with a short narrative of the business day (Beirut 04:00 to 04:00),
in the venue's language (English, French or Arabic), above the figures. The rules below write it,
in `supabase/functions/_shared/close-narrative.js`; the thresholds are the `THRESHOLDS` object at
the top of that file, and this page names each one. The rules see only the figures of the close
(`computeClose` and `computeFacts` in `supabase/functions/daily-close/handler.js`), so the
narrative never says anything the figures cannot show, and the same day always reads the same.

An optional model rewrite (off by default) is described at the end.

## The days it compares

- **Today**: the business day being closed.
- **Last week**: the same weekday 7 days earlier.
- **The trailing four weeks**: the same weekday 7, 14, 21 and 28 days earlier.

All five are computed from one load of the venue's rows, with every status as of each day's own
04:00, exactly as the close computes the day itself. A day **has takings** when its confirmed
payments (cash, digital and paid at the till, tips included) are above zero.

The **baseline** for "what moved" is last week when it has takings; otherwise the average of the
trailing weekdays that have takings, when at least `trailingMinDays` (2) of them do; otherwise
there is no baseline. Averages pool the days: the tip rate and the cash share are summed tips (or
cash) over summed takings, the average bill is weighted by the number of bills, the settlement time
is the mean of the daily medians.

## The day's facts

| Fact | Definition |
| --- | --- |
| Bills | bills closed in the window (`computeClose` `bills.closed`). The close has no cover count, so bills stand in for covers. |
| Takings | `cash + digital + till`, USD cents, tips included, as in the email table |
| Tip rate | tips / takings |
| Cash share | cash confirmed / takings (paid at the till is not cash here, as in the email) |
| Average bill | mean `totalCents` of the bills closed in the window that have a total |
| Settlement time | median minutes from a payment's request (`ts`) to its `confirmedAt`, over payments confirmed in the window, till payments excluded |
| Cash waiting | cash requests still pending at 04:00 that had waited `pendingMinutes` (10) or more by then |
| Bills open | bills still open at 04:00 (`bills.stillOpen`) |
| Refunds | refunds recorded in the window (`refunds`) |
| Rate age | whole days from `aal.rate_meta.updatedAt` to 04:00, when a rate and its date are on file |
| POS pushes | webhook deliveries created in the window with at least one failed attempt and not delivered by 04:00; unknown when the integration tables cannot be read |
| Who came back | see the last section; counts only |

## The narrative, in order

At most `maxSentences` (6) sentences, in this order: what the evening was, what moved, what to look
at, who came back. Every number is written in digits (Arabic uses Western digits). No em dash.

### Empty day (rule `empty`)

No bill opened or closed and no payment record of any kind: one line, nothing else.
"Nothing was recorded on Tuesday: no bill was opened or closed and no payment came in."
(The cron skips such a day without an email; the line is what a forced send carries.)

### 1. What the evening was (rule `evening`, always)

Bills closed and takings. Takings are in the venue's currency: with `currency` LBP and a rate on
file, lira at the day's rate with dollars in brackets; comparison amounts are lira alone.

- **Against last week**, when last week has takings: the change in takings, rounded to a whole
  percent. Under `takingsChangePct` (10%) either way it says "in line with last Tuesday"; otherwise
  "up 25%" or "down 25%". Last week's takings and bills are given in brackets.
- When last week is on record but has no takings: "last Tuesday had no takings on record".
- **Against the trailing four weeks**, when at least `trailingMinDays` (2) of them have takings:
  the same comparison against their average takings, naming how many weekdays it averages.

### 2. What moved (rules `moved.*`, after the checks have their room)

Against the baseline. Each candidate passes only above its threshold; the passing ones are ranked
by how many times their threshold they moved, and at most `maxMoved` (2) are written.

| Rule | Moves when |
| --- | --- |
| `moved.tips` | the tip rate, in whole percent, moved `tipRatePoints` (3) points or more |
| `moved.cashShare` | the cash share, in whole percent, moved `cashSharePoints` (10) points or more |
| `moved.averageBill` | the average bill moved `averageBillPct` (15%) or more, and both days had at least `averageBillMinBills` (3) bills with a total |
| `moved.settleTime` | the median settlement time moved `settleMinutes` (2) minutes or more and `settlePct` (25%) or more of the earlier median, and both days had at least `settleMinPayments` (3) timed payments |

- None passes (`moved.steady`): one sentence says tips, the cash share (and the average bill when
  it is comparable) were close to the baseline, with today's values.
- No baseline (`moved.noBaseline`): one sentence gives today's tips, tip rate and cash share and
  says there is no earlier weekday with takings to compare with.
- No takings today: no "what moved" sentence.

### 3. What to look at (rules `look.*`)

Facts, each with the thing to check, in this priority order:

| Rule | When | What it asks |
| --- | --- | --- |
| `look.pos` | one or more POS pushes failed (count, last HTTP status) | check the POS connection under Integrations |
| `look.pendingCash` | one or more cash requests waiting (count, amount, tables, how many from an earlier day) | check with the floor, then confirm or cancel |
| `look.openBills` | one or more bills open at 04:00 (count, tables) | check whether paid, then close |
| `look.refunds` | one or more refunds (count, amount) | check each against its bill |
| `look.staleRate` | the lira rate unchanged for `staleRateDays` (14) days or more (the dashboard's `A.rateInfo` rule) | check it against the till |

With none of the first four, and room, `look.none` says so: no cash waiting, no bill open, no
refund. The checks have priority over "what moved": when there are more checks than room, the
last ones are joined into one sentence (rule names joined by `+`), and "what moved" gets what is
left (possibly nothing).

### 4. Who came back (rules `back.*`)

From the growth model (`restaurant-growth.js`, `INTEGRATIONS.md`): a **visit** is a guest and bill
pair with a payment confirmed by 04:00 and linked to the guest by the receipt (`customerId`),
dated at its earliest payment. Only guests who left a receipt contact can be recognised.

| Count | Definition |
| --- | --- |
| seen | guests with a visit in the window |
| regulars | seen, previous visit under `lapsedDays` (30) days before, `regularVisits` (3) or more visits |
| returning | seen, previous visit under 30 days before, exactly 2 visits |
| lapsed | seen, previous visit `lapsedDays` (30) days or more before |
| first | seen, no earlier visit |
| second-visit candidates | guests with exactly one visit that turned `secondVisitDays` (7) days old during the window, whose latest marketing choice before 04:00 is yes: they entered the second-visit audience today |

`back.seen` lists the non-zero counts; `back.none` says no paying guest was recognised. Candidates
are added to either. Consent: the email carries counts only, never a name, an address or a number;
candidates count only guests who agreed to restaurant offers. Without the growth rows (the read
failed) there is no "who came back" sentence.

## Languages

English, French and Arabic, from `venue_profiles.lang` (`supabase/close-narrative-2026-10-28.sql`;
English when unset). French uses a comma for decimals, a narrow no-break space for thousands and
before `;`, and a no-break space before `%`, `$` and `:`. Arabic is Modern Standard Arabic with
Western digits; counted nouns follow the number (1 and 2 as words, 3 to 10 plural, 11 and up
singular), and where agreement would be fragile the sentence says "the number of ... was N".

## The optional model rewrite

`supabase/functions/_shared/close-narrative-model.js`. Only when `CLOSE_NARRATIVE_MODEL_KEY` is set
on the function: the rules' text and the day's figures (no venue name, dish, table-side text or
contact) go to the Claude API (`claude-sonnet-5-5`, effort low, server-side refusal fallback) with
strict instructions: keep every number in the same notation, add nothing, same order and length,
same language, plain prose. The rewrite is used only when it passes every check; otherwise the
rules' text goes out:

- any HTTP error, a refusal, a cut-off answer, a timeout (20 s) or no text;
- an em dash, a link or an address, a list or blank line;
- a length under 60% or over 150% of the rules' text;
- **numbers**: the multiset of numbers in the rewrite (Arabic-Indic digits read as digits,
  thousands separators dropped, the language's decimal mark read) must equal the rules' exactly.

## Preview

`node tools/close-preview.js --demo good|bad|empty [--lang fr] [--currency LBP] [--email]`
renders yesterday's narrative from five weeks of fictional Mayda activity, or from a JSON fixture
(`--fixture`), without sending anything.
