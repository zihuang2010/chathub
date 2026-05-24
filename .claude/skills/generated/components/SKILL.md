---
name: components
description: "Skill for the Components area of chathub. 52 symbols across 11 files."
---

# Components

52 symbols | 11 files | Cohesion: 78%

## When to Use

- Working with code in `frontends/`
- Understanding how useMessagesReady, checkForAppUpdates, useWindowMaxSize work
- Modifying components-related functionality

## Key Files

| File                                           | Symbols                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `frontends/components/TitleBar.tsx`            | WindowsTitleBar, ControlButton, MinimizeIcon, MaximizeIcon, RestoreIcon (+10)                      |
| `frontends/components/Splash.tsx`              | BottomScene, CityBuildings, Waves, PaperPlane, Splash (+6)                                         |
| `frontends/components/Login.tsx`               | Login, Backdrop, BottomWaves, FormCard, Tabs (+5)                                                  |
| `frontends/components/WindowResizeEdges.tsx`   | startManualResize, WindowResizeEdges, handlePointerDown, ResizeHandle, findScrollableAncestor (+2) |
| `frontends/lib/useWindowMaxSize.ts`            | isTauriRuntime, useWindowMaxSize, applyMaxSize                                                     |
| `frontends/lib/data/appReady.ts`               | useMessagesReady                                                                                   |
| `frontends/lib/updater.ts`                     | checkForAppUpdates                                                                                 |
| `frontends/App.tsx`                            | App                                                                                                |
| `frontends/components/illustrations/waves.tsx` | DriftingWave                                                                                       |
| `frontends/lib/platform.ts`                    | detectWindows11                                                                                    |

## Entry Points

Start here when exploring this area:

- **`useMessagesReady`** (Function) — `frontends/lib/data/appReady.ts:57`
- **`checkForAppUpdates`** (Function) — `frontends/lib/updater.ts:3`
- **`useWindowMaxSize`** (Function) — `frontends/lib/useWindowMaxSize.ts:14`
- **`applyMaxSize`** (Function) — `frontends/lib/useWindowMaxSize.ts:21`
- **`WindowResizeEdges`** (Function) — `frontends/components/WindowResizeEdges.tsx:233`

## Key Symbols

| Symbol               | Type     | File                                           | Line |
| -------------------- | -------- | ---------------------------------------------- | ---- |
| `useMessagesReady`   | Function | `frontends/lib/data/appReady.ts`               | 57   |
| `checkForAppUpdates` | Function | `frontends/lib/updater.ts`                     | 3    |
| `useWindowMaxSize`   | Function | `frontends/lib/useWindowMaxSize.ts`            | 14   |
| `applyMaxSize`       | Function | `frontends/lib/useWindowMaxSize.ts`            | 21   |
| `WindowResizeEdges`  | Function | `frontends/components/WindowResizeEdges.tsx`   | 233  |
| `handlePointerDown`  | Function | `frontends/components/WindowResizeEdges.tsx`   | 236  |
| `Login`              | Function | `frontends/components/Login.tsx`               | 121  |
| `DriftingWave`       | Function | `frontends/components/illustrations/waves.tsx` | 18   |
| `detectWindows11`    | Function | `frontends/lib/platform.ts`                    | 16   |
| `Splash`             | Function | `frontends/components/Splash.tsx`              | 141  |
| `TitleBar`           | Function | `frontends/components/TitleBar.tsx`            | 20   |
| `setup`              | Function | `frontends/components/TitleBar.tsx`            | 26   |
| `safeWindow`         | Function | `frontends/components/TitleBar.tsx`            | 45   |
| `onMinimize`         | Function | `frontends/components/TitleBar.tsx`            | 55   |
| `onToggleMaximize`   | Function | `frontends/components/TitleBar.tsx`            | 56   |
| `onClose`            | Function | `frontends/components/TitleBar.tsx`            | 57   |
| `handleSubmit`       | Function | `frontends/components/Login.tsx`               | 136  |
| `isTauriRuntime`     | Function | `frontends/lib/useWindowMaxSize.ts`            | 3    |
| `App`                | Function | `frontends/App.tsx`                            | 29   |
| `startManualResize`  | Function | `frontends/components/WindowResizeEdges.tsx`   | 104  |

## Execution Flows

| Flow                       | Type            | Steps |
| -------------------------- | --------------- | ----- |
| `Login → PopIn`            | cross_community | 5     |
| `Login → DropShadow`       | cross_community | 5     |
| `Login → TypingDot`        | cross_community | 5     |
| `Login → SatelliteRing`    | cross_community | 5     |
| `Workbench → DriftingWave` | cross_community | 4     |
| `App → ScopeMatches`       | cross_community | 4     |
| `Splash → PopIn`           | cross_community | 4     |
| `Splash → DropShadow`      | cross_community | 4     |
| `Splash → SatelliteRing`   | cross_community | 4     |
| `Splash → TypingDot`       | cross_community | 4     |

## Connected Areas

| Area          | Connections |
| ------------- | ----------- |
| Accounts      | 7 calls     |
| Messages      | 2 calls     |
| Illustrations | 2 calls     |
| Data          | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "useMessagesReady"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
