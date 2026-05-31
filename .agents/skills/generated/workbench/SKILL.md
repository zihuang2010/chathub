---
name: workbench
description: "Skill for the Workbench area of chathub. 13 symbols across 4 files."
---

# Workbench

13 symbols | 4 files | Cohesion: 70%

## When to Use

- Working with code in `frontends/`
- Understanding how useCurrentProfile, useHubSyncStatus, un work
- Modifying workbench-related functionality

## Key Files

| File                                              | Symbols                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `frontends/components/workbench/Sidebar.tsx`      | initialOf, onlineStatus, UserBadge, AvatarMark, broadWavePath (+4) |
| `frontends/lib/data/useHubSyncStatus.ts`          | useHubSyncStatus, un                                               |
| `frontends/lib/data/useCurrentProfile.ts`         | useCurrentProfile                                                  |
| `frontends/components/workbench/Sidebar.test.tsx` | renderSidebar                                                      |

## Entry Points

Start here when exploring this area:

- **`useCurrentProfile`** (Function) — `frontends/lib/data/useCurrentProfile.ts:13`
- **`useHubSyncStatus`** (Function) — `frontends/lib/data/useHubSyncStatus.ts:32`
- **`un`** (Function) — `frontends/lib/data/useHubSyncStatus.ts:50`
- **`Sidebar`** (Function) — `frontends/components/workbench/Sidebar.tsx:63`

## Key Symbols

| Symbol              | Type     | File                                              | Line |
| ------------------- | -------- | ------------------------------------------------- | ---- |
| `useCurrentProfile` | Function | `frontends/lib/data/useCurrentProfile.ts`         | 13   |
| `useHubSyncStatus`  | Function | `frontends/lib/data/useHubSyncStatus.ts`          | 32   |
| `un`                | Function | `frontends/lib/data/useHubSyncStatus.ts`          | 50   |
| `Sidebar`           | Function | `frontends/components/workbench/Sidebar.tsx`      | 63   |
| `initialOf`         | Function | `frontends/components/workbench/Sidebar.tsx`      | 34   |
| `onlineStatus`      | Function | `frontends/components/workbench/Sidebar.tsx`      | 40   |
| `UserBadge`         | Function | `frontends/components/workbench/Sidebar.tsx`      | 214  |
| `AvatarMark`        | Function | `frontends/components/workbench/Sidebar.tsx`      | 251  |
| `renderSidebar`     | Function | `frontends/components/workbench/Sidebar.test.tsx` | 49   |
| `broadWavePath`     | Function | `frontends/components/workbench/Sidebar.tsx`      | 24   |
| `SidebarBackdrop`   | Function | `frontends/components/workbench/Sidebar.tsx`      | 144  |
| `EdgeHandle`        | Function | `frontends/components/workbench/Sidebar.tsx`      | 287  |
| `NavButton`         | Function | `frontends/components/workbench/Sidebar.tsx`      | 319  |

## Execution Flows

| Flow                            | Type            | Steps |
| ------------------------------- | --------------- | ----- |
| `Workbench → Cn`                | cross_community | 4     |
| `Workbench → DriftingWave`      | cross_community | 4     |
| `Workbench → BroadWavePath`     | cross_community | 4     |
| `Workbench → UseCurrentProfile` | cross_community | 4     |
| `Workbench → OnlineStatus`      | cross_community | 4     |
| `Sidebar → Un`                  | cross_community | 4     |
| `Sidebar → CachedImageSrc`      | cross_community | 4     |
| `Sidebar → InitialOf`           | cross_community | 4     |

## Connected Areas

| Area       | Connections |
| ---------- | ----------- |
| Customers  | 5 calls     |
| Components | 1 calls     |
| Messages   | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "useCurrentProfile"})` — see callers and callees
2. `gitnexus_query({query: "workbench"})` — find related execution flows
3. Read key files listed above for implementation details
