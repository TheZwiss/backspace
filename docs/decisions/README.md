# Architecture decision records

This directory holds the reasoning behind the decisions that shape the
codebase: the ones that set a convention every later change has to follow, or
that close off a path. The code shows what was decided. These files record
why, what else was on the table, and what it costs, so that the next person
does not have to reconstruct the argument from a pull request thread.

An ADR is written before implementation, as the outcome of a design proposal
issue (see "Design before code" in `CONTRIBUTING.md`). Not every proposal needs
one; a maintainer asks for an ADR when the decision is large enough that its
reasoning should outlive the pull request. The mobile client architecture is
the first example (#125).

## When an ADR is required

A maintainer asks for one when a design proposal does any of:

- commits the project to a platform, runtime, or protocol choice that would
  take more than a release to reverse;
- introduces a convention that applies across the whole web client, server,
  or desktop shell rather than to one subsystem;
- resolves a disagreement between contributors, so the losing arguments are
  recorded alongside the winning one.

Subsystem specs in `docs/systems/` describe how something works today and are
updated in place. An ADR describes a choice at a point in time and is never
edited after acceptance except to change its status.

## Format

One Markdown file per decision, numbered in order of acceptance:
`NNNN-short-title.md`. Copy the skeleton below.

```markdown
# ADR NNNN: Title

| | |
|---|---|
| Status | Proposed / Accepted / Superseded by NNNN / Rejected |
| Date | YYYY-MM-DD |
| Issue | link to the design proposal |

## Summary

The decision in one paragraph, written so that a reader who stops here knows
what was chosen and the single strongest reason.

## Context

What exists today, what is missing, and the constraints that bound the
choice: platform facts, licensing, review capacity, federation. Facts here
should be checkable; cite primary sources for platform behaviour.

## Decision

What is adopted, in enough detail that an implementation can be judged
against it. Name the primitives and where they live.

## Alternatives considered

Each option that was seriously on the table, and what it would have broken
or cost.

## Consequences

What becomes easier, what becomes harder, and the rule other contributors
must now follow. Include what is deliberately not tested or not supported.
```

## Lifecycle

- **Proposed**: the pull request adding the file is open. Discussion happens
  on that pull request and on the linked issue.
- **Accepted**: merged. Implementation may begin, and pull requests for it
  link the ADR.
- **Superseded**: a later ADR replaces it. The old file stays, with its status
  updated and a link to the new one.
- **Rejected**: written up and merged because the reasoning is worth keeping
  even though the change is not.

## Index

| Number | Title | Status |
|---|---|---|
| 0001 | Mobile client architecture (#125) | Proposed |
