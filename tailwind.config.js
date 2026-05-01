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
          blue: "#348fe9",
          "blue-strong": "#2563EB",
          "blue-hover": "#1D4ED8",
          "blue-light": "#93C5FD",
          "blue-medium": "#60A5FA",
          text: "#1F2937",
          "text-secondary": "#5F6F86",
          "text-muted": "#8A96A8",
          surface: "#FFFFFF",
          "surface-subtle": "#F7FAFD",
          "surface-soft": "#F4F8FE",
          "surface-active": "#EAF2FF",
          line: "#D8E3F0",
          "line-subtle": "#E8EEF6",
          "line-strong": "#BFD0E7",
          wechat: "#07C160",
          "wechat-text": "#059669",
          "wechat-bg": "#ECFDF3",
          online: "#10B981",
          unread: "#EF4444",
          "out-bubble": "#E7F1FC",
          "out-bubble-border": "#C7DBF2",
        },
      },
      fontFamily: {
        numeric: ["SFMono-Regular", "SF Mono", "Roboto Mono", "Menlo", "Consolas", "monospace"],
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
