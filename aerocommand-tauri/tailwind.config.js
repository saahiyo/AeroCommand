/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        c2bg: "#0B0F19",
        c2sidebar: "#111827",
        c2card: "#1E293B",
        c2border: "#334155",
        c2accent: "#0EA5E9",
        c2accenthover: "#0284C7",
        c2success: "#10B981",
        c2danger: "#EF4444",
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
