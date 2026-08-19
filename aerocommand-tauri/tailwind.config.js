/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      colors: {
        c2bg: "#0A0E17",          // Deep obsidian canvas
        c2sidebar: "#0A0E17",     // Matching flush sidebar
        c2card: "#121826",        // Smooth rounded dark card
        c2cardhover: "#172033",   // Card hover surface
        c2pill: "#161E2E",        // Pill input / button surface
        c2border: "#1E2A3F",      // Crisp border line
        c2borderlight: "#2B3B57", // Highlight border line
        c2accent: "#0075FF",      // Reference Electric Blue
        c2accenthover: "#0062D6", // Hover blue
        c2cyan: "#38BDF8",        // Neon Cyan
        c2success: "#10B981",     // Mint Emerald
        c2danger: "#F43F5E",      // Rose Red
        c2warning: "#F59E0B",     // Amber
      },
      borderRadius: {
        '3xl': '24px',
        '2xl': '18px',
        'xl': '14px',
        'lg': '10px',
        'pill': '9999px',
      },
      boxShadow: {
        'card': '0 4px 20px -2px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(30, 42, 63, 0.6)',
        'pill': '0 4px 14px 0 rgba(0, 117, 255, 0.35)',
        'glow': '0 0 25px rgba(0, 117, 255, 0.25)',
      }
    },
  },
  plugins: [],
}
