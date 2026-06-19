---
name: grill-me
description: Stress-test a plan or design by interviewing the user relentlessly, one question at a time, recommending an answer each time and resolving every branch of the decision tree; explores the codebase to self-answer, and records settled decisions in MEMORY.md. Use for 'grill me', 'poke holes in this plan', or design stress-tests. Includes an optional docs mode that anchors questions to a project glossary or ADRs when the project keeps them.
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

Once we have a clear understanding of anything what is valid when written down, do so in `MEMORY.md`

Update `MEMORY.md` often and semantic.

## Docs mode (optional)

When a project keeps a glossary (`CONTEXT.md`) or architecture decision records (ADRs), anchor your questions to those documented terms instead of reinventing language. Call out any answer that conflicts with an existing definition, and prefer the canonical term when one already exists. As decisions settle, write them back into the relevant doc, updating the glossary entry or adding an ADR so the documentation stays the source of truth.

