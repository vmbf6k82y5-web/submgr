/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 状态色与 core 的中文口径一一对应：正常=绿、异常=红、已结束=灰
        ok: '#16a34a',
        warn: '#d97706',
        danger: '#dc2626',
      },
      maxWidth: {
        app: '42rem',
      },
      minHeight: {
        screen: '100dvh',
      },
    },
  },
  plugins: [],
};
