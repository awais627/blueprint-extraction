/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "drafting room at night" canvas
        page: '#04070C',
        surface: {
          1: '#080D16',
          2: '#0D1522',
          3: '#141F31',
        },
        line: {
          faint: 'rgba(125,160,215,0.07)',
          DEFAULT: 'rgba(125,160,215,0.12)',
          strong: 'rgba(125,160,215,0.22)',
        },
        ink: {
          DEFAULT: '#E6EEFA',
          secondary: '#96A9C8',
          muted: '#54678A',
        },
        // cyan "blueprint beam"
        accent: {
          DEFAULT: '#35C8EE',
          bright: '#67DCF9',
          deep: '#1596BC',
          ink: '#04222E', // text on accent fills
        },
        good: '#2FD08A',
        warn: '#F5B93E',
        crit: '#F2645A', // redline
      },
      fontFamily: {
        display: ['"Space Grotesk Variable"', 'system-ui', 'sans-serif'],
        sans: ['"Space Grotesk Variable"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 rgba(125,160,215,0.06) inset, 0 1px 2px rgba(0,0,0,0.5), 0 12px 32px -16px rgba(0,0,0,0.7)',
        pop: '0 1px 0 rgba(125,160,215,0.08) inset, 0 8px 24px rgba(0,0,0,0.55), 0 24px 64px -16px rgba(0,0,0,0.8)',
        beam: '0 0 0 1px rgba(53,200,238,0.35), 0 4px 20px -4px rgba(53,200,238,0.45)',
        'beam-soft': '0 0 24px -6px rgba(53,200,238,0.35)',
      },
      letterSpacing: {
        label: '0.14em',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        ants: {
          to: { strokeDashoffset: '-24' },
        },
        scan: {
          '0%': { top: '-8%' },
          '100%': { top: '108%' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.7)', opacity: '0.7' },
          '100%': { transform: 'scale(1.8)', opacity: '0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out both',
        'fade-up': 'fade-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in 0.18s ease-out both',
        ants: 'ants 0.7s linear infinite',
        scan: 'scan 2.6s cubic-bezier(0.45, 0, 0.55, 1) infinite',
        blink: 'blink 1.6s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite',
      },
    },
  },
  plugins: [],
}
