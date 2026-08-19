/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Segoe UI Variable"', '"Segoe UI"', '"Plus Jakarta Sans"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', '"Cascadia Code"', 'monospace'],
      },
      colors: {
        c2bg: "#0B0F19",          // Windows 11 Dark Canvas
        c2sidebar: "#0F1420",     // Flush Sidebar Panel
        c2card: "#141A29",        // Clean Desktop Card
        c2cardhover: "#1A2235",   // Hover Card
        c2pill: "#182030",        // Desktop input / surface
        c2border: "#202B3F",      // Windows 11 subtle border
        c2borderlight: "#2C3B55", // Highlight border
        c2accent: "#0078D4",      // Windows 11 Accent Blue
        c2accenthover: "#006CBE", // Hover blue
        c2cyan: "#38BDF8",        // Sky Blue
        c2success: "#10B981",     // Emerald
        c2danger: "#EF4444",      // Red
        c2warning: "#F59E0B",     // Amber
      },
      borderRadius: {
        '2xl': '12px',
        'xl': '10px',
        'lg': '8px',
        'md': '6px',
        'sm': '4px',
        'pill': '9999px',
      },
      boxShadow: {
        'card': '0 2px 8px rgba(0, 0, 0, 0.35)',
        'dropdown': '0 8px 24px rgba(0, 0, 0, 0.45)',
      }
    },
  },
  plugins: [],
}
