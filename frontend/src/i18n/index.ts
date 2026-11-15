import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import es from './es.json';
import type { Lang } from '../lib/types';

// Namespaces. en.json and es.json are the default namespace ("translation"). A feature that adds many strings
// puts them in its own pair of files, i18n/en/<name>.json and i18n/es/<name>.json: every file in those folders
// becomes the namespace <name> automatically (use `useTranslation('<name>')`, or `t('<name>:key')`). Both
// languages must have the same files and keys: i18n/parity.test.ts checks every namespace.
function namespaces(files: Record<string, { default: unknown }>): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [path, mod] of Object.entries(files)) {
    const name = /\/([^/]+)\.json$/.exec(path)?.[1];
    if (name) out[name] = mod.default as object;
  }
  return out;
}
const enNs = namespaces(import.meta.glob('./en/*.json', { eager: true }));
const esNs = namespaces(import.meta.glob('./es/*.json', { eager: true }));

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en, ...enNs }, es: { translation: es, ...esNs } },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'translation',
  ns: ['translation', ...Object.keys(enNs)],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setLanguage(lang: Lang): void {
  if (i18n.language !== lang) void i18n.changeLanguage(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export default i18n;
