---
name: components
description: "Skill for the Components area of chathub. 49 symbols across 10 files."
---

# Components

49 symbols | 10 files | Cohesion: 75%

## When to Use

- Working with code in `frontends/`
- Understanding how detectWindows11, Splash, DriftingWave work
- Modifying components-related functionality

## Key Files

| File                                           | Symbols                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `frontends/components/TitleBar.tsx`            | WindowsTitleBar, ControlButton, MinimizeIcon, MaximizeIcon, RestoreIcon (+10)                      |
| `frontends/components/Splash.tsx`              | Splash, Spinner, Features, VersionBadge, BrandStrip (+6)                                           |
| `frontends/components/Login.tsx`               | FormCard, Tabs, Field, Checkbox, SubmitButton (+5)                                                 |
| `frontends/components/WindowResizeEdges.tsx`   | startManualResize, WindowResizeEdges, handlePointerDown, ResizeHandle, findScrollableAncestor (+2) |
| `frontends/lib/platform.ts`                    | detectWindows11                                                                                    |
| `frontends/components/ui/button.tsx`           | Button                                                                                             |
| `frontends/components/illustrations/waves.tsx` | DriftingWave                                                                                       |
| `frontends/lib/data/appReady.ts`               | useMessagesReady                                                                                   |
| `frontends/lib/updater.ts`                     | checkForAppUpdates                                                                                 |
| `frontends/App.tsx`                            | App                                                                                                |

## Entry Points

Start here when exploring this area:

- **`detectWindows11`** (Function) — `frontends/lib/platform.ts:16`
- **`Splash`** (Function) — `frontends/components/Splash.tsx:143`
- **`DriftingWave`** (Function) — `frontends/components/illustrations/waves.tsx:18`
- **`useMessagesReady`** (Function) — `frontends/lib/data/appReady.ts:57`
- **`checkForAppUpdates`** (Function) — `frontends/lib/updater.ts:3`

## Key Symbols

| Symbol               | Type     | File                                           | Line |
| -------------------- | -------- | ---------------------------------------------- | ---- |
| `detectWindows11`    | Function | `frontends/lib/platform.ts`                    | 16   |
| `Splash`             | Function | `frontends/components/Splash.tsx`              | 143  |
| `DriftingWave`       | Function | `frontends/components/illustrations/waves.tsx` | 18   |
| `useMessagesReady`   | Function | `frontends/lib/data/appReady.ts`               | 57   |
| `checkForAppUpdates` | Function | `frontends/lib/updater.ts`                     | 3    |
| `Login`              | Function | `frontends/components/Login.tsx`               | 121  |
| `TitleBar`           | Function | `frontends/components/TitleBar.tsx`            | 20   |
| `setup`              | Function | `frontends/components/TitleBar.tsx`            | 26   |
| `safeWindow`         | Function | `frontends/components/TitleBar.tsx`            | 45   |
| `onMinimize`         | Function | `frontends/components/TitleBar.tsx`            | 55   |
| `onToggleMaximize`   | Function | `frontends/components/TitleBar.tsx`            | 56   |
| `onClose`            | Function | `frontends/components/TitleBar.tsx`            | 57   |
| `WindowResizeEdges`  | Function | `frontends/components/WindowResizeEdges.tsx`   | 233  |
| `handlePointerDown`  | Function | `frontends/components/WindowResizeEdges.tsx`   | 236  |
| `handleSubmit`       | Function | `frontends/components/Login.tsx`               | 136  |
| `WindowsTitleBar`    | Function | `frontends/components/TitleBar.tsx`            | 188  |
| `ControlButton`      | Function | `frontends/components/TitleBar.tsx`            | 245  |
| `MinimizeIcon`       | Function | `frontends/components/TitleBar.tsx`            | 262  |
| `MaximizeIcon`       | Function | `frontends/components/TitleBar.tsx`            | 270  |
| `RestoreIcon`        | Function | `frontends/components/TitleBar.tsx`            | 278  |

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
| Accounts      | 8 calls     |
| Messages      | 2 calls     |
| Illustrations | 2 calls     |
| Data          | 1 calls     |
| Cluster_188   | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "detectWindows11"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
