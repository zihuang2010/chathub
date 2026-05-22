---
name: illustrations
description: "Skill for the Illustrations area of chathub. 14 symbols across 4 files."
---

# Illustrations

14 symbols | 4 files | Cohesion: 96%

## When to Use

- Working with code in `frontends/`
- Understanding how BubbleBlue, BubbleGreen, BubblePurple work
- Modifying illustrations-related functionality

## Key Files

| File                                                | Symbols                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `frontends/components/illustrations/bubbles.tsx`    | popIn, dropShadow, typingDot, BubbleBlue, BubbleGreen (+2) |
| `frontends/components/Login.tsx`                    | BrandPanel, BrandIllustration, IllustrationHalos           |
| `frontends/components/Splash.tsx`                   | Illustration, Halos, FloatDot                              |
| `frontends/components/illustrations/satellites.tsx` | SatelliteRing                                              |

## Entry Points

Start here when exploring this area:

- **`BubbleBlue`** (Function) — `frontends/components/illustrations/bubbles.tsx:37`
- **`BubbleGreen`** (Function) — `frontends/components/illustrations/bubbles.tsx:78`
- **`BubblePurple`** (Function) — `frontends/components/illustrations/bubbles.tsx:119`
- **`BubbleWhite`** (Function) — `frontends/components/illustrations/bubbles.tsx:189`
- **`SatelliteRing`** (Function) — `frontends/components/illustrations/satellites.tsx:26`

## Key Symbols

| Symbol              | Type     | File                                                | Line |
| ------------------- | -------- | --------------------------------------------------- | ---- |
| `BubbleBlue`        | Function | `frontends/components/illustrations/bubbles.tsx`    | 37   |
| `BubbleGreen`       | Function | `frontends/components/illustrations/bubbles.tsx`    | 78   |
| `BubblePurple`      | Function | `frontends/components/illustrations/bubbles.tsx`    | 119  |
| `BubbleWhite`       | Function | `frontends/components/illustrations/bubbles.tsx`    | 189  |
| `SatelliteRing`     | Function | `frontends/components/illustrations/satellites.tsx` | 26   |
| `BrandPanel`        | Function | `frontends/components/Login.tsx`                    | 234  |
| `BrandIllustration` | Function | `frontends/components/Login.tsx`                    | 273  |
| `IllustrationHalos` | Function | `frontends/components/Login.tsx`                    | 327  |
| `Illustration`      | Function | `frontends/components/Splash.tsx`                   | 200  |
| `Halos`             | Function | `frontends/components/Splash.tsx`                   | 219  |
| `FloatDot`          | Function | `frontends/components/Splash.tsx`                   | 462  |
| `popIn`             | Function | `frontends/components/illustrations/bubbles.tsx`    | 21   |
| `dropShadow`        | Function | `frontends/components/illustrations/bubbles.tsx`    | 24   |
| `typingDot`         | Function | `frontends/components/illustrations/bubbles.tsx`    | 29   |

## Execution Flows

| Flow                        | Type            | Steps |
| --------------------------- | --------------- | ----- |
| `Login → PopIn`             | cross_community | 5     |
| `Login → DropShadow`        | cross_community | 5     |
| `Login → TypingDot`         | cross_community | 5     |
| `Login → SatelliteRing`     | cross_community | 5     |
| `Splash → PopIn`            | cross_community | 4     |
| `Splash → DropShadow`       | cross_community | 4     |
| `Splash → SatelliteRing`    | cross_community | 4     |
| `Splash → TypingDot`        | cross_community | 4     |
| `Login → IllustrationHalos` | cross_community | 4     |
| `Splash → Halos`            | cross_community | 3     |

## How to Explore

1. `gitnexus_context({name: "BubbleBlue"})` — see callers and callees
2. `gitnexus_query({query: "illustrations"})` — find related execution flows
3. Read key files listed above for implementation details
