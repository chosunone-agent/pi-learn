---
name: visualize
description: Add ONE correct, minimal picture to a lesson — a diagram or a geometric figure — by delegating to a maker subagent that renders it and visually verifies it before returning. Use when an idea is genuinely clearer as a picture (relationships, structure, flow, or spatial/geometric content) and prose alone would be worse.
---

# Visualize

A picture earns its place only when it shows something words cannot: shape, structure, direction, relationship, geometry. This skill produces **one** such picture, guarantees it is correct — the maker renders it and *looks* at it before returning — and hands back a file you embed in the lesson.

You are the **creative director**. You decide the exact idea and reduce it to its fewest carrying elements. A **maker subagent** does the authoring, rendering, visual verification, and saving, then returns a filename. You embed that filename.

## When to visualize, and when not to

This system builds a dependency graph in the learner's head: unconditional truths at the root, derived facts hanging off them. A visual is powerful exactly when it makes that structure — or a geometry — visible.

Reach for one when:

- The idea is a **structure or relationship**: dependencies, a system with parts and arrows, a flow, a sequence, a state machine, a hierarchy, a comparison, a containment (what is inside vs outside).
- The idea is **spatial or geometric**: coordinate geometry, a number line, a vector, a function's shape, a physical arrangement.

Do **not** visualize when prose or one equation already carries it. A diagram that merely restates the sentence beside it adds noise and one more chance to be wrong. When in doubt, don't: a missing picture is cheaper than a false one.

## Choose the maker

Three makers, each with its own authoring tools. Pick by what the picture *is*:

| Maker | Reach for it when | Examples |
|---|---|---|
| `mermaid-maker` | nodes and edges, automatic layout is fine | dependency graphs, flowcharts, sequence, state, ER, class, trees, timelines |
| `graphviz-maker` | nodes and edges, but layout must be **steered** | explicit reading order, clusters that visibly contain members, ranked layers, weighted primary paths |
| `svg-maker` | positions and shapes matter exactly | coordinate geometry, number lines, vectors, function plots, annotated figures, physical layouts |

Rules of thumb:
- Nodes-and-edges → `mermaid-maker`. It is the default and fits the dependency-graph pedagogy directly.
- Mermaid lays it out badly (things far apart, needless crossings, wrong order) → `graphviz-maker`.
- Geometry, coordinates, or anything where an element must sit at an exact place → `svg-maker`.

## Brief the maker well

The most common failure is **cramming**: every extra label makes the picture harder to read *and* harder to get right. Before briefing, prune to the fewest elements that carry the idea. For each, ask: *if I remove this, is the idea still clear?* If yes, remove it.

Give the maker the concept **and** the concrete elements you want — not a vague topic, and not a long checklist.

- Bad: "make a diagram about how TCP works"
- Good: "graph TD: a node 'packet' at the top; arrows down to 'ordering' and 'retransmit on loss'; both down into 'reliable stream'. No title. Show that reliability is built FROM packets, not alongside them."

Keep the idea intact but let the maker compose. If your brief lists more than about seven elements, cut it first.

## Invoke

Dispatch exactly one maker with the `subagent` tool:

```
subagent(agent="mermaid-maker", task="<minimal, concrete brief>")
```

```
subagent(agent="graphviz-maker", task="<minimal, concrete brief>")
```

```
subagent(agent="svg-maker", task="<minimal, concrete brief>")
```

The maker owns its own tools (`write_*`, `edit_*`, `render_*`), renders to a PNG, **looks at the PNG and iterates until it is correct**, publishes into `<project>/viz/` under a unique name, and returns:

```
RESULT:
filename: viz-<slug>-<timestamp>.png
path: <project>/viz/viz-<slug>-<timestamp>.png
```

If it returns `RESULT: NONE`, it could not make a correct picture of the brief: simplify, choose a different maker, or decide the visual is not worth it.

**Never hand-author or fake a diagram yourself.** Correctness depends on the maker's render-and-inspect loop; a picture you write without looking is exactly the failure mode this skill exists to prevent.

## Embed it

Put the embed directly in your teaching reply. The `md-log` extension mirrors your reply text verbatim into the lesson file, so a relative image reference resolves from there:

```markdown
<img src="../viz/viz-<slug>-<timestamp>.png" alt="<short description>" width="520">
```

`width="520"` is a good default; use more for dense diagrams. Introduce the visual in a sentence, then let it carry the idea — do not narrate every element back in prose.

## Why this is reliable

- The maker never returns a picture it has not **looked at**, so "renders fine but says something false" is caught before the learner sees it.
- The PNG is verified by the maker and embedded as-is, so what was checked is what the learner sees — no re-render drift.
- Unique filenames keep old notes pointing at the picture they were written against.

## If the makers are unavailable

The makers are supplied by `pi-subagents` agents in this package. If a dispatch fails because the agent is not found, or because a renderer is missing, say so plainly and continue the lesson without the picture. A missing visual is fine; a wrong one is not. Do not substitute a hand-written diagram.
