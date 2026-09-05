module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
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
          900: "#006064"
        },
        hot: "#00BCD4",
        warm: "#FF9800",
        cold: "#607D8B"
      }
    }
  },
  plugins: []
};
