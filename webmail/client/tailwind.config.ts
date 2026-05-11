import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Superhuman design tokens — dark app palette
        mysteria: {
          DEFAULT: '#1b1938',
          50:  '#eeedf8',
          100: '#d4d2f0',
          200: '#a9a4e0',
          300: '#7e77d1',
          400: '#5349c1',
          500: '#3d3394',
          600: '#312a77',
          700: '#26215d',
          800: '#1b1938',
          900: '#0f0e20',
        },
        lavender: {
          DEFAULT: '#cbb7fb',
          dim: '#9b87d4',
          faint: 'rgba(203,183,251,0.12)',
          border: 'rgba(203,183,251,0.20)',
        },
        surface: {
          base: '#0d0c1a',
          elevated: '#13121f',
          overlay: '#1a1928',
          border: 'rgba(255,255,255,0.07)',
          'border-strong': 'rgba(255,255,255,0.13)',
        },
        ink: {
          DEFAULT: '#e8e6f0',
          secondary: 'rgba(232,230,240,0.65)',
          muted: 'rgba(232,230,240,0.38)',
          disabled: 'rgba(232,230,240,0.22)',
        },
        cream: '#e9e5dd',
        amethyst: '#714cb6',
        parchment: '#dcd7d3',
      },
      boxShadow: {
        'glow-sm': '0 0 12px rgba(203,183,251,0.15)',
        'glow-md': '0 0 28px rgba(203,183,251,0.22)',
        'elevated': '0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3)',
        'panel': '0 8px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)',
        'command': '0 24px 80px rgba(0,0,0,0.7), 0 8px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': { from: { transform: 'translateY(6px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        'slide-down': { from: { transform: 'translateY(-4px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        'row-archive': { to: { transform: 'translateX(-100%)', opacity: '0', height: '0', marginBottom: '0' } },
        'row-delete': { to: { transform: 'translateX(100%)', opacity: '0', height: '0', marginBottom: '0' } },
        'toast-in': { from: { transform: 'translateY(12px) scale(0.96)', opacity: '0' }, to: { transform: 'translateY(0) scale(1)', opacity: '1' } },
        'shimmer': { from: { backgroundPosition: '-200% 0' }, to: { backgroundPosition: '200% 0' } },
        'pulse-dot': { '0%,100%': { opacity: '1', transform: 'scale(1)' }, '50%': { opacity: '0.5', transform: 'scale(0.85)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'slide-up': 'slide-up 0.18s cubic-bezier(0.32,0.72,0,1)',
        'slide-down': 'slide-down 0.15s cubic-bezier(0.32,0.72,0,1)',
        'row-archive': 'row-archive 0.22s cubic-bezier(0.32,0.72,0,1) forwards',
        'row-delete': 'row-delete 0.22s cubic-bezier(0.32,0.72,0,1) forwards',
        'toast-in': 'toast-in 0.22s cubic-bezier(0.32,0.72,0,1)',
        'shimmer': 'shimmer 1.6s linear infinite',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
