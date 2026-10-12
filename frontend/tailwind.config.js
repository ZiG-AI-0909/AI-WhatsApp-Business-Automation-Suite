module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          100: "#E0F7FA",
          200: "#B2EBF2",
          300: "#80DEEA",
          400: "#4DD0E1",
          500: "#00BCD4",
          600: "#00ACC1",
          700: "#0097A7",
          800: "#00838F",
          900: "#006064",
        },
        hot: "#FF5722",
        warm: "#FF9800",
        cold: "#607D8B",
        success: "#10B981",
        danger: "#EF4444",
        warning: "#F59E0B",
        neutral: "#9CA3AF",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
      },
      // Custom utility classes
      backgroundColor: {
        base: "#f8fafc",
      },
    },
  },
  plugins: [
    function ({ addComponents, theme }) {
      addComponents({
        ".card": {
          "background-color": theme("colors.white"),
          "border-radius": theme("borderRadius.2xl"),
          "box-shadow": theme("boxShadow.md"),
          padding: theme("spacing.8"),
        },
        ".badge-soft": {
          display: "inline-flex",
          "align-items": "center",
          gap: theme("spacing.1"),
          "padding-left": theme("spacing.2"),
          "padding-right": theme("spacing.2"),
          "padding-top": theme("spacing.0.5"),
          "padding-bottom": theme("spacing.0.5"),
          "border-radius": theme("borderRadius.full"),
          "background-color": theme("colors.teal.50"),
          color: theme("colors.teal.700"),
        },
      });
    },
  ],
};
