---
name: Amethyst Intelligence
colors:
  background: '#080611'
  surface: '#131020'
  surface-container: '#211B31'
  surface-container-low: '#191426'
  surface-container-high: '#30204E'
  on-background: '#F7F3FF'
  on-surface: '#F7F3FF'
  on-surface-variant: '#AAA2BB'
  outline: '#A78BFA'
  outline-variant: 'rgba(220, 200, 255, 0.14)'
  primary: '#A78BFA'
  on-primary: '#1D1035'
  primary-container: '#30204E'
  on-primary-container: '#E9DDFF'
  secondary: '#22D3EE'
  on-secondary: '#062D36'
  secondary-container: '#123440'
  on-secondary-container: '#B9F5FF'
  tertiary: '#34D399'
  on-tertiary: '#052E23'
  tertiary-container: '#123B31'
  on-tertiary-container: '#B6F4DD'
  success: '#34D399'
  warning: '#FBBF24'
  error: '#FB7185'
  error-container: '#3F1721'
typography:
  display:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
  headline:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
  title:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
rounded:
  sm: 0.5rem
  DEFAULT: 0.75rem
  lg: 0.75rem
  full: 9999px
spacing:
  base: 8px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 48px
  max-width: 1280px
motion:
  duration-fast: 120ms
  duration-base: 200ms
  duration-slow: 320ms
  easing-standard: cubic-bezier(0.2, 0, 0, 1)
  easing-emphasized: cubic-bezier(0.3, 0, 0.1, 1)
icon:
  style: line
  strokeWidth: 1.5
  grid: 24px
  sizes: [16px, 20px, 24px]
---

# Amethyst Intelligence

## Brand and style

A trustworthy AI infrastructure interface with an amethyst brand core. The experience is professional, transparent and technically advanced, while the purple visual language makes Agent selection and workflow orchestration memorable.

Use a deep violet-black background across the product, including first-time visits and users with an old saved light preference. Violet expresses the brand, primary actions, AI capability and orchestration. Cyan is a sparse high-energy accent for live protocol signals. Teal remains reserved for escrow protection and confirmed financial states. Green means successful completion. Amber means pending or attention required. Red means error, dispute, or irreversible risk. Always pair semantic color with text and an icon.

Brand glow is allowed only around hero focal points, selected Agent cards and active workflow nodes. It must fade into the surrounding surface and may never reduce text contrast. Gradients should reinforce hierarchy rather than fill every component.

## Typography

Use Inter with Chinese system sans-serif fallback. Amounts, task status, deadlines, and transaction state must be easy to scan. Avoid decorative fonts. Use monospace only for wallet addresses, task IDs, and transaction hashes.

## Layout

Use an 8px spacing system, 12-column desktop grid, 1280px maximum content width, and 24px gutters. Desktop-first at 1440px. Cards use 12px radius and form controls use 8px radius. Prefer translucent borders, tonal surfaces and layered depth. Use glow shadows only on branded focal points; dense operational views remain calm and scannable.

## Components

Use consistent navigation, buttons, form controls, task cards, Agent cards, status badges, tables, tabs, filters, drawers, modals, alerts, timelines, wallet state, escrow state, and on-chain transaction state. Interfaces are data-rich but calm and highly scannable.

## Accessibility

Meet WCAG AA contrast, show keyboard focus, use 44px minimum interactive targets, and never encode status with color alone.

## Data formatting

Trust in a financial product is carried by the numbers, not just the palette. Amounts, timestamps, and identifiers must render identically everywhere they appear.

- Amounts: fixed decimal precision per currency (e.g. 2 decimals for stablecoins, up to 6 for ETH display values — never show raw 18-decimal wei), thousands separators, currency label always attached, right-aligned in tables and lists.
- Never let an amount's decimal count shift between screens (list, detail, preview, receipt) for the same currency.
- Timestamps: absolute time on hover/detail, relative time ("3 分钟前") on list views; always the same relative-time phrasing across the product, not different phrasings per page.
- Wallet addresses and transaction hashes: shortened form `0x1234…abcd` with a copy affordance, full value available on hover or click — never truncate silently without a way to get the full value.
- Percentages and scores (matching score, ratings): one decimal place, consistent rounding rule, never re-derive the same score differently on two screens.

## Motion

Motion communicates that the system is working, not stalled — critical for a product full of async on-chain and Agent-execution waits. Use the `motion` tokens; do not introduce ad hoc durations or easing per page.

- State transitions (task status, escrow status, assignment status) use `duration-base` with `easing-standard`: a brief crossfade or badge swap, never an instant hard cut and never a bouncy/playful easing.
- Pending → confirmed transitions (on-chain confirmation, Agent acceptance) get a slightly more deliberate `duration-slow` transition so the change is noticeable, not missed.
- Loading and waiting states animate continuously (skeleton shimmer, spinner) but never use motion to simulate progress that isn't real — don't fake a progress bar for an indeterminate wait.
- No decorative motion (parallax, bouncing icons, celebratory confetti on payment) — restraint is part of the trust signal.

## Iconography

One icon set, one style, everywhere. Use the `icon` tokens: line icons only (no filled/duotone mixing), 1.5px stroke, drawn on a 24px grid, available at 16/20/24px. Icons always pair with a text label in status contexts (per Accessibility) — an icon alone is never the only carrier of meaning.

## Loading and empty states

Every async view (candidate matching, execution progress, transaction confirmation) needs all four states designed, not just the happy path:

- **Skeleton**: for initial content load, shaped like the real layout (card/table skeletons match final card/table geometry), not a generic spinner, so the page doesn't visually jump when data arrives.
- **Empty**: explains *why* it's empty and what to do next (e.g. "无候选 Agent — 尝试放宽预算或标签"), never a bare "无数据".
- **Error**: states what failed and offers a retry action; uses `error` color restrained to the message and icon, not the whole panel.
- **Offline/degraded** (SSE disconnected, chain sync delayed): uses `warning`, not `error` — this is a connectivity state, not a failure, and should say so.

## Avoid

No crypto casino aesthetics, rainbow neon, cyberpunk terminal styling, excessive glassmorphism, speculative token widgets, unrelated crypto charts, mixed-language UI, or generic chatbot layouts. Purple and cyan effects must remain subordinate to content and status semantics.
