# Comparison: Cluster Memory vs. a knowledge-graph skill

Both approaches attack the same problem - an agent that re-derives what the project
already knows - from different ends. This page records what was measured, how, and
where each one wins.

## What is being compared

| | [graphify](https://github.com/Graphify-Labs/graphify) skill | Cluster Memory |
|---|---|---|
| Unit of knowledge | structural node and edge in a graph | one answered question |
| Extraction | tree-sitter AST + LLM + vision (docs, PDFs, images) | none: the agent writes what it concluded |
| Answers "what calls this / what breaks if I change it" | yes, that is the point | no |
| Answers "where did we look when we discussed this" | by traversal from a seed | directly, by keyword |
| Survives compaction | yes (graph is a file) | yes (trail is a file) |
| Cost of a lookup | traversal output, 70–560 tokens | 230 tokens, one small read |
| Cost to build | an extraction run, optional model keys | nothing: it accumulates as you work |
| Cold start on a new project | useful immediately after a build | empty until the first `remember` |

They are complementary. Cluster Memory is the cheap first layer; a graph is the
structural second layer. The skill says so and hands off.

## Measured costs

Method: serialized size in UTF-8 bytes, tokens estimated at **3.6 bytes/token** for
JSON and English prose (the usual ratio for this kind of text). All figures measured
on a real 2-file project with a populated trail, Windows, Node 24.

| Operation | Bytes | ≈ tokens |
|---|---|---|
| `where` hit (files + nodes + conclusion) | 840 | **233** |
| `where` miss (descent instructions) | 610 | 170 |
| `summary` | 420 | 117 |
| `remember` confirmation | 300 | 83 |
| Graph traversal answer (`graphify query`) | 2 003 | 556 |
| Graph node explanation (`graphify explain`) | 593 | 165 |
| One mid-size source file read | - | 1 500–2 500 |
| Session-history search (search → trace) | - | 3 000–6 000 |

Read that table as the reason for the layer order: a trail hit is **6–10× cheaper
than opening one file** and **13–26× cheaper than a history search**.

## The fixed cost that a skill avoids

A tool-based integration pays for its schemas on **every request**, whether or not it
is used. Measured on the DSH plugin version of this approach (`dsh-graphify`, 15
tools): **20 905 bytes ≈ 5 800 tokens per request**, plus ≈500 tokens for a
five-tool session-history bundle.

A skill pays nothing per request: `SKILL.md` is loaded on demand, and a script
invocation only costs its own output. On a 30k-token request the difference is ~19%
of the context window - which is why the skill shape exists.

The trade: the plugin can subscribe to every tool result and trail automatically; a
skill relies on the model calling `remember`, or on agent hooks (`examples/`). Where
hooks exist, the skill gets most of the automation back at none of the per-request
cost.

## Where a graph still wins

- "What breaks if I change this function" - reverse traversal needs the graph.
- "How do these two modules reach each other" - the trail cannot know it.
- PDFs, papers, screenshots, office files - only the graph's LLM/vision pass reads
  those.
- A brand-new repository nobody has asked about yet - the graph has content on
  minute one; the trail is empty until questions are answered.

## Where Cluster Memory wins

- The same question asked a second time - 233 tokens and no tool churn.
- A decision that was never in the code but was concluded out loud.
- Long sessions where compaction silently drops the pointers (file names, function
  names); the trail keeps them.
- Projects that cannot afford an extraction run, an API key, or a 5.8k-token schema
  budget.

## Reproducing a comparison honestly

If you publish numbers, publish the method with them:

1. Run the same question through each layer with a fixed agent and model.
2. Sum the tokens of every tool result the agent received while answering.
3. Repeat over a set of questions, not one - a single question can flatter any layer.
4. Report misses: a layer that answers cheaply half the time is not cheaper than one
   that answers always.

Anecdotes ("the assistant said it felt better") are a starting point, not evidence.
