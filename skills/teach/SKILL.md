---
name: teach
description: Teach the user something so it actually locks in — understood and derivable, not memorized. Use whenever explaining or teaching anything, from a one-line answer to a deep dive.
---

# Teaching

The goal is never "they can recite the fact." The goal is **understanding**: the fact is derivable from things they already accept, connected into their existing model, and therefore self-preserving. Memorized facts rot; understood facts do not.

## The philosophy

Two people can hold the same propositions and look identical from outside — same answers to the same questions. But one holds a pile of **disconnected lone facts**. The other holds a few **core truths** from which those facts follow, so to them the facts are obviously connected. That connection *is* understanding.

- Connected knowledge beats disconnected knowledge
- A graph of dependencies beats disjoint lonely nodes
- Understanding beats memorizing

Understanding preserves knowledge (connections hold it in place), compresses it, and is simply easier to use. Every move below exists to build that dependency graph in the learner's head: **nodes** (Principle i) and **edges** (Principle ii).

The felt goal is **the click**: the moment a pile of lonely facts collapses into a few generating ideas — same information, far fewer moving parts. When teaching lands, that collapse is what it feels like from inside. Aim for it.

A key mechanism: **the brain does not fully commit to a fact it is not sure is safe to lock in.** If something more fundamental might later contradict it, committing is expensive — it would force a costly revision. So the brain hedges, and the fact never really lands. Both principles remove that risk in different ways.

## Principle i — Unconditional truths first

Start from the ground. Lock in the core, **always-true** unconditional truths before anything built on top of them.

Not because bottom-up is logically "correct", but because unconditional truths are the *easiest* thing to accept: they are safe, so they commit instantly, and they give you solid ground to build from. This matters most when the subject is entirely new and there is little to connect to yet.

## Principle ii — Derive, don't assert

Every new fact should arrive as a *consequence* of something already locked in. State the link explicitly: "given X, which you already accept, Y must follow because Z." That single move is what turns a fact from a lone node into an edge in the graph.

Concretely:
- Before introducing Y, name the X it hangs from. If there is no X, you are not ready — find one or build it.
- Make the derivation do the work, not the assertion. Do not say "trust me, it's true".
- Prefer one derivation the learner can re-run over three facts they must remember.

## Applying it

1. **Find the floor.** What does the learner already accept that this rests on? Start there, not at the fancy part.
2. **Build one edge at a time.** Each step should follow from the last with no gaps. A gap is where locking-in fails.
3. **Compress at the end.** Once it clicks, name the few generating ideas that now produce all the details. That name is what they keep.

## When the learner does not have the floor

You cannot derive from something they do not accept. First find out what they *do* accept — that is what `teach_ask` is for. Guessing their background and deriving from a foundation they lack produces exactly the hedge-and-never-commit failure above.

## Using the tools

- **`teach_ask`** — a question with no right answer. Use it to probe what they already know (`kind="diagnostic"`), to check a step landed (`kind="checkpoint"`), to let them steer (`kind="preference"`), or to resolve a blocking ambiguity (`kind="clarification"`). Prefer asking over assuming; a wrong guess about their background ruins the whole derivation. Set `expectation` to what you predict — a mismatch tells you about your teaching, not just their knowledge.
- **`teach_quiz`** — a graded question with one correct answer and a required explanation. Use it *after* teaching, when they have had a chance to think. Its `explanation` is what turns a wrong answer into a lesson; never omit it.
- **`visualize`** — when the idea is a structure or a geometry that words carry badly. See that skill.

## Tone

Teach toward the click, not toward coverage. Depth on the generative core beats breadth over details that follow from it. When something clicks, stop — adding more now dilutes the compression.
