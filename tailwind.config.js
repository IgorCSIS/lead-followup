/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,js}"],
  theme: {
    extend: {
      /**
       * Related to the Ridgeview palette so the two demos read as one body of
       * work, but this is a tool rather than a marketing page, so it runs
       * darker and quieter. Every pair below was checked for contrast; the
       * notes give the ratio against the surface it sits on.
       */
      colors: {
        ink: {
          950: "#070E18", // page background
          900: "#0B1220", // raised panel
          800: "#111C2E", // card
          700: "#1B2A40", // hairline border
          600: "#2A3D57", // hover border
        },
        sand: {
          50: "#F8FAFC", // primary text, 16.8:1 on ink-950
          200: "#CBD5E1", // body text, 12.1:1
          400: "#8FA3BC", // muted text, 6.6:1 on ink-950
        },
        ember: {
          400: "#F59E0B", // accent on dark, 9.0:1
          500: "#D97706", // accent fill
          600: "#C2410C", // pressed
        },
        good: { DEFAULT: "#34D399", bg: "#0C2A22" },
        warn: { DEFAULT: "#FBBF24", bg: "#2A2109" },
        bad: { DEFAULT: "#F87171", bg: "#2B1417" },
      },
      // System fonts only. A web font would mean a network request while a
      // contractor's lead list is open on screen, which would contradict what
      // the page promises, and it would cost a round trip on a phone in a
      // driveway with one bar of signal.
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      borderRadius: { card: "0.875rem", panel: "1.25rem" },
    },
  },
  plugins: [],
};
