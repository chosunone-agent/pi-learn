# pi-learn

A teaching and learning system for [pi](https://github.com/earendil-works/pi), tailored to this
machine.

> **Credit:** this is an independent implementation **based on
> [amosblomqvist/learn](https://github.com/amosblomqvist/learn)** by
> [@amosblomqvist](https://github.com/amosblomqvist) — "My AI learning system" (the system from the
> video [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU)). The teaching
> philosophy, the ask/quiz/log split, and the maker-subagent approach to figures all come from that
> project. What changed is described under [Differences from the original](#differences-from-the-original).
> See also [Provenance](#provenance) for the licensing situation.

## What it gives you

- **`teach` skill** — a teaching philosophy (unconditional truths first, derive rather than assert)
  that drives how anything gets explained.
- **`teach_ask`** — one structured question with authored options, an optional free-text row, and a
  first-class "I don't know". Carries a `kind` (diagnostic / checkpoint / preference / clarification)
  and an `expectation`, so a surprising answer is legible as a signal about the teaching.
- **`teach_quiz`** — a graded question with a required explanation, seeded shuffling, and instant
  ✓/✗/`I don't know` feedback. `I don't know` is never recorded as wrong.
- **`md-log`** — mirrors a session into a readable markdown lesson file, questions before answers,
  with injected skill bodies replaced by a one-line note.
- **`visualize` skill + three maker subagents** — `mermaid-maker`, `graphviz-maker`, `svg-maker`
  author a figure, render it to a PNG, *look at it*, iterate until it is correct, and publish it to
  `<project>/viz/`.

## Differences from the original

| Original | Here | Reason |
|---|---|---|
| tool named `ask_user_question` | `teach_ask` / `teach_quiz` | The name collides with `@juicesharp/rpiv-ask-user-question`, which is installed. A duplicate tool name is a hard load failure, and the two model different things. |
| `system-prompt: append`, `auto-exit: true` | `systemPromptMode: append` | The original keys are not recognised by `pi-subagents`; they were silently ignored. |
| tools registered via a `globalThis.__pi_interactive_subagents` global | `subagentOnlyExtensions` in the agent frontmatter | `pi-subagents` does not provide that global, so the makers would have launched with no tools. |
| macOS-only Chrome paths | Linux paths first | Chrome is at `/usr/bin/google-chrome-stable` here; the original fell through to a puppeteer download that may not exist. |
| Obsidian vault + wikilink embeds | `<project>/lessons/` + `<project>/viz/`, relative markdown | No vault-root assumption; renders in Obsidian, GitHub, and plain viewers. |
| pinned to `anthropic/claude-sonnet-5`, `openrouter/z-ai/glm-5.3` | providers actually configured | Those models are not available here. |
| mermaid + svg | mermaid + graphviz + svg | Graphviz gives layout control Mermaid cannot; `dot` was already installed. |

## Install

```sh
pi install ~/source/pi-learn
```

Then verify inside a project:

```sh
pi --list-models            # sanity
/agents                     # the three makers should be listed under "Visuals"
```

Mermaid rendering needs the package's own dependency tree:

```sh
cd ~/source/pi-learn && npm install
```

`rsvg-convert` (or ImageMagick) and `dot` must be on `PATH` for SVG and Graphviz. Run
`/renderers` inside a maker session to see what is available and what is missing.

## Use

```
/learn-log <topic|path>     # start mirroring the session into a lesson file
/learn-unlog                # stop
```

A bare word is a topic and becomes `lessons/<YYYY-MM-DD>-<topic>.md`, created for you. Anything with a
path separator or a `.md` suffix is treated as an explicit path and must already exist, so a typo
cannot scatter files.

Then just ask to be taught something. The `teach` skill drives the explanation; the model reaches for
`teach_ask` to probe and `teach_quiz` to check. Ask for a diagram and the `visualize` skill dispatches
a maker.

## Development

```sh
node --test "tests/*.test.ts"
```

The tests are adversarial: they pin the invariants that a plausible implementation gets wrong — that
`render()` never emits a line wider than the width it was given (pi treats that as a crash), that
grading agrees with the shuffled order the learner actually saw, that "I don't know" is never graded
as incorrect, and that an ambiguous exact-match edit is refused rather than guessed.

### Verified against pi 0.99.1

Extensions use the documented event and tool APIs; the makers were exercised end to end through
`pi-subagents` and produced real, visually confirmed PNGs.

## Provenance

This repository is a derivative work based on
[amosblomqvist/learn](https://github.com/amosblomqvist/learn), which carries **no license file and no
license statement**. Absent a license, that project's text is "all rights reserved" by default, so the
permission to redistribute its prose is not mine to grant.

### What is original here, and what is derived

**Original to this repository** — written for this environment, no upstream counterpart:

- `extensions/` — the `teach_ask` / `teach_quiz` tool schemas and result envelopes; the
  `kind` / `expectation` / `allowUnsure` fields; the shared-pop-up component in `lib/choice-view.ts`
  (with its width-keyed render cache); `lib/grading.ts` including seeded shuffling and the
  display-order grading contract; `lib/question-schema.ts`; `lib/reconcile-tools.ts`;
  `lib/paths.ts`; and the `/learn-log` topic-vs-path behaviour.
- `tools/` — the authoring-tool factory and all three renderer files; `renderers.ts`.
- `agents/graphviz-maker.md` — entirely new (Graphviz support does not exist upstream).
- All of `tests/` — the upstream project ships no tests.
- The `pi-subagents` wiring (`subagentOnlyExtensions`), the Linux renderer support, the per-project
  `lessons/` + `viz/` layout, and the relative-markdown embed scheme.

**Derived from upstream** — the design came from there, and the wording still overlaps. Percentages
are measured eight-word-shingle overlap of the file's text against its upstream counterpart:

| File | Verbatim overlap with upstream | Origin |
|---|---|---|
| `skills/teach/SKILL.md` | 14% | rewritten from the original teaching skill |
| `skills/visualize/SKILL.md` | 28% | restructured for three makers; embeds changed |
| `agents/mermaid-maker.md` | 15% | new file; workflow mirrors the original svg-maker/mermaid-maker |
| `agents/graphviz-maker.md` | 0% | entirely new |
| `agents/svg-maker.md` | 38% | same workflow; frontmatter and publish target changed |
| `extensions/teach-ask.ts` | 3% | new schema (kind/expectation/allowUnsure) and new component |
| `extensions/teach-quiz.ts` | 6% | same idea; grading anchored to display order |
| `extensions/md-log.ts` | 11% | adapted paths + package layout |
| `tools/mermaid-tools.ts` | 2% | three-tool loop kept; render returns inline image |

Anything not listed above is either original or ordinary boilerplate. The teaching philosophy itself —
two principles, unconditional truths first and derive-don't-assert — is the upstream author's idea and
is credited as such at the top of this file; I reimplemented it for these tools rather than inventing it.

### Reuse

- The `LICENSE` file covers only the original work listed above.
- **No license is asserted over the derived material**, because this repository cannot grant rights it
  does not have.
- If you intend to reuse this commercially or redistribute it widely, ask the upstream author first.
- If you are the upstream author and would prefer changes, removal, or a specific attribution form,
  please open an issue and it will be handled.
