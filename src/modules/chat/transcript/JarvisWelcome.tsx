import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { BRAND_LOGO, PRODUCT_NAME } from '@/shared/jarvis';
import { GREETING_DRAW, greeting, greetingLocale, returningUser } from '@/modules/chat/utils/jarvisGreeting';

type JarvisWelcomeProps = {
  textareaRef: RefObject<HTMLTextAreaElement>;
  setInput: (value: string) => void;
  /** The user has conversations other than this one (the greeting's "welcome back" phrases are only for them). */
  hasEarlierConversations: boolean;
};

/** The first name, asked of the router once per page load (at most 1.5 s; null when there is none). */
let firstNamePromise: Promise<string | null> | null = null;
function loadFirstName(): Promise<string | null> {
  firstNamePromise ??= Promise.race([
    api.jarvis
      .me()
      .then((r: Response) => (r.ok ? r.json() : null))
      .then((j: { firstName?: unknown } | null) => (typeof j?.firstName === 'string' ? j.firstName : null))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);
  return firstNamePromise;
}

const EXAMPLE_KEYS = ['one', 'two', 'three'] as const;

/**
 * The staff build's empty chat (ChatMessagesPane renders it instead of the provider picker): there is
 * one assistant, so YYC's logo, a time-of-day greeting (utils/jarvisGreeting.ts) and a few example requests that
 * fill the composer.
 */
export default function JarvisWelcome({ textareaRef, setInput, hasEarlierConversations }: JarvisWelcomeProps) {
  const { t, i18n } = useTranslation('jarvis');
  // undefined until the router has answered: the heading stays blank meanwhile, so it never swaps
  const [firstName, setFirstName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadFirstName().then((n) => { if (live) setFirstName(n); });
    return () => { live = false; };
  }, []);
  const returning = returningUser(hasEarlierConversations);

  const applyExample = (text: string) => {
    setInput(text);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg text-center">
        <img src={BRAND_LOGO} alt={PRODUCT_NAME} className="mx-auto mb-4 h-12 w-12 rounded-xl" />
        {/* the time-of-day greeting replaces a heading and a description line (as in the old YYC AI UI) */}
        <h2 className="mb-6 text-2xl font-semibold text-foreground">
          {firstName === undefined
            ? '\u00a0'
            : greeting(greetingLocale(i18n.language), new Date(), GREETING_DRAW, firstName, returning)}
        </h2>
        <div className="flex flex-col gap-2">
          {EXAMPLE_KEYS.map((key) => {
            const text = t(`welcome.examples.${key}`);
            return (
              <button
                key={key}
                type="button"
                onClick={() => applyExample(text)}
                className="rounded-xl border border-border/70 bg-card px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent/60"
              >
                {text}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
