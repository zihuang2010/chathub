<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **chathub** (5189 symbols, 9687 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource                                 | Use for                                  |
| ---------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/chathub/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/chathub/clusters`       | All functional areas                     |
| `gitnexus://repo/chathub/processes`      | All execution flows                      |
| `gitnexus://repo/chathub/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |
| Work in the Messages area (208 symbols)      | `.claude/skills/generated/messages/SKILL.md`                |
| Work in the Customers area (132 symbols)     | `.claude/skills/generated/customers/SKILL.md`               |
| Work in the Cluster_6 area (63 symbols)      | `.claude/skills/generated/cluster-6/SKILL.md`               |
| Work in the Api area (57 symbols)            | `.claude/skills/generated/api/SKILL.md`                     |
| Work in the Accounts area (57 symbols)       | `.claude/skills/generated/accounts/SKILL.md`                |
| Work in the Tests area (49 symbols)          | `.claude/skills/generated/tests/SKILL.md`                   |
| Work in the Components area (46 symbols)     | `.claude/skills/generated/components/SKILL.md`              |
| Work in the Cluster_72 area (30 symbols)     | `.claude/skills/generated/cluster-72/SKILL.md`              |
| Work in the Cluster_91 area (23 symbols)     | `.claude/skills/generated/cluster-91/SKILL.md`              |
| Work in the Store area (21 symbols)          | `.claude/skills/generated/store/SKILL.md`                   |
| Work in the Storage area (21 symbols)        | `.claude/skills/generated/storage/SKILL.md`                 |
| Work in the Cluster_106 area (20 symbols)    | `.claude/skills/generated/cluster-106/SKILL.md`             |
| Work in the Cluster_111 area (17 symbols)    | `.claude/skills/generated/cluster-111/SKILL.md`             |
| Work in the Cluster_87 area (16 symbols)     | `.claude/skills/generated/cluster-87/SKILL.md`              |
| Work in the Cluster_90 area (15 symbols)     | `.claude/skills/generated/cluster-90/SKILL.md`              |
| Work in the Illustrations area (14 symbols)  | `.claude/skills/generated/illustrations/SKILL.md`           |
| Work in the Cluster_35 area (13 symbols)     | `.claude/skills/generated/cluster-35/SKILL.md`              |
| Work in the Workbench area (13 symbols)      | `.claude/skills/generated/workbench/SKILL.md`               |
| Work in the Cluster_68 area (11 symbols)     | `.claude/skills/generated/cluster-68/SKILL.md`              |
| Work in the Cluster_60 area (9 symbols)      | `.claude/skills/generated/cluster-60/SKILL.md`              |

<!-- gitnexus:end -->
