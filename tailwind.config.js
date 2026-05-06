/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./frontends/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        workbench: {
          // Canonical accent (use this going forward).
          accent: "hsl(var(--wb-accent))",
          "accent-hover": "hsl(var(--wb-accent-hover))",
          "accent-soft": "hsl(var(--wb-accent-soft))",
          // Legacy blue aliases (variables resolve to --wb-accent* in index.css).
          blue: "hsl(var(--wb-blue))",
          "blue-strong": "hsl(var(--wb-blue))",
          "blue-hover": "hsl(var(--wb-blue-hover))",
          "blue-light": "hsl(var(--wb-blue-light))",
          "blue-medium": "hsl(var(--wb-blue-medium))",
          link: "hsl(var(--wb-link))",
          text: "hsl(var(--wb-text))",
          "text-secondary": "hsl(var(--wb-text-secondary))",
          "text-muted": "hsl(var(--wb-text-muted))",
          surface: "hsl(var(--wb-surface))",
          "surface-subtle": "hsl(var(--wb-surface-subtle))",
          "surface-soft": "hsl(var(--wb-surface-soft))",
          "surface-active": "hsl(var(--wb-surface-active))",
          "bubble-in": "hsl(var(--wb-bubble-in))",
          "bubble-in-border": "hsl(var(--wb-bubble-in-border))",
          "bubble-out": "hsl(var(--wb-bubble-out))",
          "bubble-out-border": "hsl(var(--wb-bubble-out-border))",
          // Legacy aliases — keep until all callers migrate.
          "out-bubble": "hsl(var(--wb-bubble-out))",
          "out-bubble-border": "hsl(var(--wb-bubble-out-border))",
          line: "hsl(var(--wb-line))",
          "line-subtle": "hsl(var(--wb-line-subtle))",
          "line-strong": "hsl(var(--wb-line-strong))",
          wechat: "hsl(var(--wb-wechat))",
          "wechat-text": "hsl(var(--wb-wechat))",
          "wechat-bg": "hsl(var(--wb-wechat-bg))",
          online: "hsl(var(--wb-online))",
          unread: "hsl(var(--wb-unread))",
          success: "hsl(var(--wb-success))",
          warning: "hsl(var(--wb-warning))",
          danger: "hsl(var(--wb-danger))",
          thumb: "hsl(var(--wb-thumb))",
          "thumb-hover": "hsl(var(--wb-thumb-hover))",
          "avatar-1": "hsl(var(--wb-avatar-1))",
          "avatar-2": "hsl(var(--wb-avatar-2))",
          "avatar-3": "hsl(var(--wb-avatar-3))",
          "avatar-4": "hsl(var(--wb-avatar-4))",
          "avatar-5": "hsl(var(--wb-avatar-5))",
          "avatar-6": "hsl(var(--wb-avatar-6))",
          "avatar-7": "hsl(var(--wb-avatar-7))",
          "avatar-8": "hsl(var(--wb-avatar-8))",
        },
      },
      fontFamily: {
        numeric: ["SFMono-Regular", "SF Mono", "Roboto Mono", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        // Workbench type scale — eliminates half-pixel arbitrary values.
        "wb-3xs": ["11px", { lineHeight: "1.5" }],
        "wb-2xs": ["12px", { lineHeight: "1.55" }],
        "wb-xs": ["13px", { lineHeight: "1.65" }],
        "wb-sm": ["14px", { lineHeight: "1.55" }],
        "wb-base": ["15px", { lineHeight: "1.5" }],
        "wb-md": ["16px", { lineHeight: "1.5" }],
      },
      boxShadow: {
        "wb-popover": "var(--wb-shadow-popover)",
        "wb-popover-strong": "var(--wb-shadow-popover-strong)",
        "wb-bubble": "var(--wb-shadow-bubble)",
        "wb-badge": "var(--wb-shadow-badge)",
        "wb-card": "var(--wb-shadow-card)",
        "wb-card-soft": "var(--wb-shadow-card-soft)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
