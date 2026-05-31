---
name: components
description: "Skill for the Components area of chathub. 46 symbols across 7 files."
---

# Components

46 symbols | 7 files | Cohesion: 78%

## When to Use

- Working with code in `frontends/`
- Understanding how Login, DriftingWave, detectWindows11 work
- Modifying components-related functionality

## Key Files

| File                                           | Symbols                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `frontends/components/TitleBar.tsx`            | WindowsTitleBar, ControlButton, MinimizeIcon, MaximizeIcon, RestoreIcon (+10)                      |
| `frontends/components/Splash.tsx`              | BottomScene, CityBuildings, Waves, PaperPlane, Splash (+6)                                         |
| `frontends/components/Login.tsx`               | Login, Backdrop, BottomWaves, FormCard, Tabs (+5)                                                  |
| `frontends/components/WindowResizeEdges.tsx`   | startManualResize, WindowResizeEdges, handlePointerDown, ResizeHandle, findScrollableAncestor (+2) |
| `frontends/components/illustrations/waves.tsx` | DriftingWave                                                                                       |
| `frontends/lib/platform.ts`                    | detectWindows11                                                                                    |
| `frontends/components/ui/button.tsx`           | Button                                                                                             |

## Entry Points

Start here when exploring this area:

- **`Login`** (Function) — `frontends/components/Login.tsx:121`
- **`DriftingWave`** (Function) — `frontends/components/illustrations/waves.tsx:18`
- **`detectWindows11`** (Function) — `frontends/lib/platform.ts:16`
- **`Splash`** (Function) — `frontends/components/Splash.tsx:143`
- **`TitleBar`** (Function) — `frontends/components/TitleBar.tsx:20`

## Key Symbols

| Symbol              | Type     | File                                           | Line |
| ------------------- | -------- | ---------------------------------------------- | ---- |
| `Login`             | Function | `frontends/components/Login.tsx`               | 121  |
| `DriftingWave`      | Function | `frontends/components/illustrations/waves.tsx` | 18   |
| `detectWindows11`   | Function | `frontends/lib/platform.ts`                    | 16   |
| `Splash`            | Function | `frontends/components/Splash.tsx`              | 143  |
| `TitleBar`          | Function | `frontends/components/TitleBar.tsx`            | 20   |
| `setup`             | Function | `frontends/components/TitleBar.tsx`            | 26   |
| `safeWindow`        | Function | `frontends/components/TitleBar.tsx`            | 45   |
| `onMinimize`        | Function | `frontends/components/TitleBar.tsx`            | 55   |
| `onToggleMaximize`  | Function | `frontends/components/TitleBar.tsx`            | 56   |
| `onClose`           | Function | `frontends/components/TitleBar.tsx`            | 57   |
| `WindowResizeEdges` | Function | `frontends/components/WindowResizeEdges.tsx`   | 233  |
| `handlePointerDown` | Function | `frontends/components/WindowResizeEdges.tsx`   | 236  |
| `handleSubmit`      | Function | `frontends/components/Login.tsx`               | 136  |
| `Backdrop`          | Function | `frontends/components/Login.tsx`               | 204  |
| `BottomWaves`       | Function | `frontends/components/Login.tsx`               | 624  |
| `BottomScene`       | Function | `frontends/components/Splash.tsx`              | 371  |
| `CityBuildings`     | Function | `frontends/components/Splash.tsx`              | 389  |
| `Waves`             | Function | `frontends/components/Splash.tsx`              | 403  |
| `PaperPlane`        | Function | `frontends/components/Splash.tsx`              | 423  |
| `WindowsTitleBar`   | Function | `frontends/components/TitleBar.tsx`            | 188  |

## Execution Flows

| Flow                        | Type            | Steps |
| --------------------------- | --------------- | ----- |
| `Login → PopIn`             | cross_community | 5     |
| `Login → DropShadow`        | cross_community | 5     |
| `Login → TypingDot`         | cross_community | 5     |
| `Login → SatelliteRing`     | cross_community | 5     |
| `Workbench → DriftingWave`  | cross_community | 4     |
| `Splash → PopIn`            | cross_community | 4     |
| `Splash → DropShadow`       | cross_community | 4     |
| `Splash → SatelliteRing`    | cross_community | 4     |
| `Splash → TypingDot`        | cross_community | 4     |
| `Login → IllustrationHalos` | cross_community | 4     |

## Connected Areas

| Area          | Connections |
| ------------- | ----------- |
| Customers     | 7 calls     |
| Illustrations | 2 calls     |
| Messages      | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "Login"})` — see callers and callees
2. `gitnexus_query({query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
