/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        c2bg: "#040711",          // Deep Pitch Black-Blue
        c2sidebar: "#070C18",     // High-contrast deep panel
        c2card: "#0B1326",        // Crisp Dark Navy-Black Card
        c2border: "#1E2E4A",      // High-contrast visible border
        c2borderlight: "#2E4368", // Lighter subtle divider
        c2accent: "#00A3FF",      // Vivid Electric Blue
        c2accenthover: "#0084D6", // Hover blue
        c2cyan: "#38BDF8",        // Bright Sky Blue
        c2white: "#FFFFFF",       // Pure White
        c2success: "#10B981",     // Emerald
        c2danger: "#EF4444",      // Red
        c2warning: "#F59E0B",     // Amber
      },
      borderRadius: {
        DEFAULT: '4px',
        sm: '2px',
        md: '4px',
        lg: '6px',
        xl: '8px',
      }
    },
  },
  plugins: [],
}
