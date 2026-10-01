# pi-learn

A teaching and learning system for [pi](https://github.com/earendil-works/pi), tailored to this
machine. It is an independent implementation inspired by
[amosblomqvist/learn](https://github.com/amosblomqvist/learn), reworked around the tools and
conventions actually present here.

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

## Why this differs from the original

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
