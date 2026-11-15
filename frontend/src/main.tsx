import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import './styles/index.css';
import './i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { startBackendProbe } from './lib/backend';
import { browserLang } from './lib/url-state';
import { setLanguage } from './i18n';
import { AppErrorBoundary } from './features/errors/AppErrorBoundary';
import { installErrorReporting, reactRootErrorOptions } from './lib/errorReport';

installErrorReporting();
setLanguage(browserLang());
startBackendProbe();

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root, reactRootErrorOptions).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
