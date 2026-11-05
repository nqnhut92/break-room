# Architecture Decision Records

[Documentation](../README.md) · [Architecture](../ARCHITECTURE.md)

ADRs record significant decisions and their tradeoffs. They explain why the architecture looks this way; guides describe how to use and operate it. Keep one canonical English record per decision to avoid conflicting statuses across translations.

Records 0001–0004 document decisions already present in the code and project notes. Their recorded date is when the rationale was collected here, not a claim about the original decision date. Alternatives are comparisons, not claims that every alternative was prototyped.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-shared-state.md) | Accepted | Share authoritative state through a store contract and atomic Redis operations |
| [0002](0002-leased-npc-runners.md) | Accepted | Use leased NPC runners and fence durable state updates |
| [0003](0003-direct-rendering.md) | Accepted; safe-mode shadow detail amended by 0005 | Render directly without a post-processing composer |
| [0004](0004-static-world.md) | Accepted | Share a static world and collision model with stable object IDs |
| [0005](0005-safe-mode-shadows.md) | Accepted | Disable real-time shadow passes in safe mode |

| [0006](0006-account-identity.md) | Accepted | Separate Google accounts, durable Postgres characters and Redis session/control ownership |

| [0007](0007-dynamic-actor-collision.md) | Accepted | Share swept boss-body collision across client/server while players and bots remain nonblocking |

| [0008](0008-daily-scores-and-chat.md) | Accepted | Persist daily room scores through a durable Redis queue into Postgres, and store 24-hour chat |

## Adding or changing a decision

Copy [template.md](template.md) to the next unused `NNNN-short-title.md`. Start new proposals as **Proposed**; mark them **Accepted** when agreed or implemented. Explain context, the choice, alternatives and consequences, and link code, relevant guides and verification evidence. Do not invent historical dates, benchmarks or rejected experiments.

Correct factual errors in place. If a decision changes, add a new ADR and mark the previous record **Superseded by NNNN**, with reciprocal links; keep its original reasoning. Update this index and the affected guides. Minor bug fixes and balance adjustments do not need an ADR unless they change an architectural decision.
