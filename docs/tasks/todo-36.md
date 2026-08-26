# Todo — #36 · M3-5 Large exports stay responsive

Branch: `36-large-exports` (stacked on `35-pdf-german`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a large project exports without freezing the UI
  Given a project with 500 devices
  Then progress is shown
  And the interface remains responsive
  And the export can be cancelled
```

> **Approach:** measure first, then move generation to a **web worker** if the measurement
> justifies it. This is the strongest candidate for one in the whole application.
>
> But measure. A worker costs message-passing and serialisation.

## Review

**Measured first, and the measurement said not to build the worker.** It also said the freeze
was real and severe, and pointed at somewhere I would not have looked.

### The verdict

| | Longest main-thread block, 200 devices |
|---|---|
| Before | **8,098ms** |
| After | under 250ms, worst single step 42ms |

No web worker. Two changes, neither of which is a thread.

### What the measurement actually found

The first instinct was right about the symptom and wrong about the cause twice over.

**The loop was not the problem.** Every `await` in the export settles on a *microtask* —
`element.updateComplete` is one — and a microtask continues the *same task*. So a loop full of
`await`s ran as one unbroken block, painting nothing. `yieldToBrowser()` fixes that, using a
`MessageChannel` rather than `setTimeout(…, 0)`: after five levels of nesting the specification
clamps timers to 4ms, and an export yields once per device, so five hundred devices would spend
two seconds waiting for timers.

That took 8,098ms down to 5,609ms — better, and still frozen.

**I then measured the wrong thing and nearly shipped the fix for it.** A comparison of
`save()` against `save({ useObjectStreams: false })` reported 1158ms against 6ms, which looked
like an enormous free win. It was an artefact: both were measured on the **same document**, and
pdf-lib caches its normalisation, so whichever call ran second was fast because the first had
done the work. Measured properly on two separate documents, object streams are the *faster* of
the two — 25ms against 61ms — as well as producing the smaller file. The change was reverted.

**The real cause was that `embedPng` is lazy.** It registers an embedder and does the decoding
and deflating at *save* time, so two hundred images were processed in one synchronous call
after the last progress callback — while the loop above looked perfectly well-behaved.
Instrumenting by phase found it immediately: `after=5583ms`, `worstStep=15ms`. Calling
`pdf.flush()` inside the loop does that work where the yield can break it up. `after` became
24ms.

### Why the measurement is a test rather than a note

"It was fine when I checked" is not a property anyone can rely on six months later. The
responsiveness test measures the **longest gap between animation frames** — not total time,
which a long export is allowed to have, but the longest stretch in which nothing could be
painted and no input handled.

**It has a positive control**, and this file needed it more than most: a headless or
backgrounded browser throttles `requestAnimationFrame`, which would turn every number here into
a measurement of the harness. The control passed, which is what let the 5.6-second reading be
believed rather than blamed on the runner (lesson L3).

And there is a second assertion that *locates* rather than merely detects: the time between the
last progress callback and the finished document. A frame-gap measurement alone says "something
blocked"; that one says "the block is after the loop", which is the sentence that would have
saved an hour.

### Cancellation

Already present from M3-1, and now tested for the property that makes it true: an export stops
within a device or two of being told to. A cancel honoured after the remaining four hundred
devices have been drawn is not a cancel.

### On 500 versus 200

The tests use 200 rather than the issue's 500, because 500 devices is roughly a two-minute test
and the failure mode is not device-count-dependent — a block that exists at 200 exists at 500,
proportionally larger. The per-device cost is now flat, so 500 devices is 2.5× the duration and
the same responsiveness.
