import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import net from 'node:net';

const backend = process.env.DESTELLO_BACKEND ?? 'http://localhost:8000';

/** Development helper: reports whether the backend port accepts connections (keeps the console quiet when it does not). */
function backendProbe(): Plugin {
  const url = new URL(backend);
  return {
    name: 'destello-backend-probe',
    configureServer(server) {
      server.middlewares.use('/__backend_up', (_req, res) => {
        const sock = net.connect({ host: url.hostname, port: Number(url.port || 80), timeout: 800 });
        const done = (up: boolean) => {
          sock.destroy();
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ up }));
        };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.once('timeout', () => done(false));
      });
    },
  };
}

/** Replaces %VITE_PUBLIC_URL% in index.html: the site origin of the build, else the local default. */
function publicUrl(): Plugin {
  let origin = 'http://localhost:8080';
  return {
    name: 'destello-public-url',
    configResolved(config) {
      const v = String(config.env.VITE_PUBLIC_URL ?? '')
        .trim()
        .replace(/\/+$/, '');
      if (v) origin = v;
    },
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('%VITE_PUBLIC_URL%', origin) },
  };
}

/** Preloads the fonts of the first paint (body text and the hero heading) so the text does not wait for the CSS to name them. */
function preloadFonts(): Plugin {
  const wanted = [/inter-latin-400-normal/, /inter-latin-500-normal/, /space-grotesk-latin-500-normal/];
  return {
    name: 'destello-preload-fonts',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        return Object.keys(ctx.bundle)
          .filter((f) => f.endsWith('.woff2') && wanted.some((re) => re.test(f)))
          .map((f) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${f}`, crossorigin: '' },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), backendProbe(), publicUrl(), preloadFonts()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/frames': backend,
      '/manifests': backend,
      // Same sky map route as the Caddyfile (`@hips`): two fixed IRSA HiPS surveys only.
      '/hips': {
        target: 'https://irsa.ipac.caltech.edu',
        changeOrigin: true,
        rewrite: (p: string) =>
          /^\/hips\/(2MASS\/Color|AllWISE\/RGB-W4-W2-W1)\/(properties|Moc\.fits|Norder\d{1,2}\/Allsky\.jpg|Norder\d{1,2}\/Dir\d{1,9}\/Npix\d{1,9}\.jpg)$/.test(
            p,
          )
            ? p.replace(/^\/hips\//, '/data/hips/CDS/')
            : '/data/hips/CDS/__not_allowed__',
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: application releases do not invalidate the framework code in browser caches.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@tanstack')) return 'tanstack';
          if (/i18next/.test(id)) return 'i18n';
          if (id.includes('@radix-ui')) return 'radix';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
  },
});
