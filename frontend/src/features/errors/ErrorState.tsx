// Reusable error view: optional status code, one h1, a sentence, optional detail and actions.
// Focus moves to the heading on mount so keyboard and screen reader users land on the message.
import { useEffect, useRef, type ReactNode } from 'react';
import { useSeo } from '../../lib/seo';

export interface ErrorStateProps {
  title: string;
  description: string;
  actions?: ReactNode;
  /** Status code shown above the heading, for example "404". */
  status?: string;
  /** Extra content between the description and the actions. */
  children?: ReactNode;
  /** Small muted line below the actions (error reference). */
  footnote?: ReactNode;
  testId?: string;
  /** Document title to set while the view is mounted. */
  docTitle?: string;
}

export function ErrorState({
  title,
  description,
  actions,
  status,
  children,
  footnote,
  testId = 'error-state',
  docTitle,
}: ErrorStateProps) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  // Error views are never indexed; the title comes from the page that raised them.
  useSeo({ title: docTitle, index: false });

  return (
    <main id="main" className="mx-auto w-full max-w-[720px] px-4 py-12 md:px-6 md:py-20" data-testid={testId}>
      <div className="flex flex-col items-start gap-4">
        <img src="/brand/destello-mark-color-dark.svg" alt="" width={40} height={40} className="size-10" />
        {status ? (
          <p className="font-mono text-label-13 text-muted" data-testid="error-status">
            {status}
          </p>
        ) : null}
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-display-32 font-semibold text-text focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          {title}
        </h1>
        <p className="max-w-[60ch] text-body-15 text-text-2">{description}</p>
        {children}
        {actions ? <div className="flex flex-wrap items-center gap-3 pt-2">{actions}</div> : null}
        {footnote ? <p className="break-all font-mono text-label-13 text-muted">{footnote}</p> : null}
      </div>
    </main>
  );
}
