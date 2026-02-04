/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      spacing: {
        'timer': '3rem',      // 48px - пространство вокруг таймера
        'section': '1.5rem',  // 24px - между секциями
        'element': '0.75rem', // 12px - между элементами
        'tight': '0.5rem',   // 8px - плотное spacing
      },
      borderRadius: {
        lg: "var(--radius)",        // 8px - для cards
        md: "calc(var(--radius) - 2px)", // 6px - для кнопок, inputs (macOS standard)
        sm: "calc(var(--radius) - 4px)", // 4px - для индикаторов
        ui: "6px",                  // Явный 6px для UI элементов
        indicator: "4px",           // Явный 4px для индикаторов
      },
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
          soft: "hsl(var(--destructive-soft))",
          softHover: "hsl(var(--destructive-soft-hover))",
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
        timer: {
          running: "hsl(var(--timer-running))",
          runningDark: "hsl(var(--timer-running-dark))",
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}

