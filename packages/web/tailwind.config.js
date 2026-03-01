/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // ── LEGACY (preserved until Phase 5 removal) ──
        discord: {
          // Backgrounds (darkest → lightest) — Discord "Dark" theme
          'bg-floating':       '#080a0b',
          'bg-tertiary':       '#111214',
          'bg-server':         '#111214',
          'bg-user-area':      '#1a1b1e',
          'bg-secondary':      '#1e1f22',
          'bg-members':        '#1e1f22',
          'bg-home':           '#1a1d20',
          'bg-hover':          '#232428',
          'bg-primary':        '#232428',
          'bg-input':          '#2b2d31',
          'bg-surface':        '#2b2d31',
          'bg-surface-higher': '#313338',
          'bg-active':         '#313338',
          'bg-accent':         '#353840',
          'bg-overlay':        'rgba(0, 0, 0, 0.90)',

          // Text
          'text-primary':   '#ffffff',
          'text-normal':    '#dcdcdf',
          'text-secondary': '#c5c6ca',
          'text-muted':     '#abacb2',
          'text-header':    '#ffffff',
          'text-link':      '#76aff6',
          'text-positive':  '#73c48b',
          'text-warning':   '#faa900',
          'text-danger':    '#ff938e',

          // Channel/Interactive
          'channels-default':  '#999aa1',
          'interactive-muted': '#4e5058',

          // Brand
          'blurple':        '#5865f2',
          'blurple-hover':  '#4452bb',
          'blurple-active': '#3a48a3',

          // Status
          'green':      '#23a55a',
          'yellow':     '#f0b232',
          'red':        '#f23f43',
          'red-hover':  '#a9232e',

          // Notification badge
          'notification': '#da3e44',

          // Modifiers (semi-transparent — works on any background)
          'modifier-hover':    'rgba(255,255,255,0.08)',
          'modifier-active':   'rgba(255,255,255,0.16)',
          'modifier-selected': 'rgba(255,255,255,0.20)',
          'modifier-accent':   'rgba(255,255,255,0.12)',
        },

        // ── AETHER DRIFT TOKENS ──
        surface: {
          base:     'var(--bg-base)',
          channel:  'var(--bg-channel)',
          chat:     'var(--bg-chat)',
          members:  'var(--bg-members)',
          elevated: 'var(--bg-elevated)',
          input:    'var(--bg-input)',
          overlay:  'var(--bg-overlay)',
        },
        border: {
          hard: 'var(--border-hard)',
          soft: 'var(--border-soft)',
        },
        accent: {
          mint:            'var(--accent-mint)',
          peach:           'var(--accent-peach)',
          lavender:        'var(--accent-lavender)',
          sky:             'var(--accent-sky)',
          amber:           'var(--accent-amber)',
          rose:            'var(--accent-rose)',
          coral:           'var(--accent-coral)',
          primary:         'var(--accent-primary)',
          'primary-hover': 'var(--accent-primary-hover)',
          'primary-active':'var(--accent-primary-active)',
        },
        txt: {
          primary:   'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary:  'var(--text-tertiary)',
          message:   'var(--text-message)',
          link:      'var(--text-link)',
          positive:  'var(--text-positive)',
          warning:   'var(--text-warning)',
          danger:    'var(--text-danger)',
        },
        interactive: {
          hover:    'var(--interactive-hover)',
          active:   'var(--interactive-active)',
          selected: 'var(--interactive-selected)',
          muted:    'var(--interactive-muted)',
        },
        status: {
          online:  'var(--status-online)',
          idle:    'var(--status-idle)',
          dnd:     'var(--status-dnd)',
          offline: 'var(--status-offline)',
        },
        glass: {
          bg:        'var(--glass-bg)',
          border:    'var(--glass-border)',
          highlight: 'var(--glass-highlight)',
        },
        notification: 'var(--notification)',
      },
      boxShadow: {
        'header': '0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05)',
        'elevation-low': '0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05)',
        'elevation-high': '0 8px 16px rgba(0, 0, 0, 0.24)',
        'glass': '0 2px 8px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.15), inset 0 1px 0 var(--glass-highlight)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
