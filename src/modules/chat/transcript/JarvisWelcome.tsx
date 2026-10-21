import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { BRAND_LOGO, PRODUCT_NAME } from '@/shared/jarvis';

type JarvisWelcomeProps = {
  textareaRef: RefObject<HTMLTextAreaElement>;
  setInput: (value: string) => void;
};

const EXAMPLE_KEYS = ['one', 'two', 'three'] as const;

/**
 * The staff build's empty chat (ChatMessagesPane renders it instead of the provider picker): there is
 * one assistant, so a greeting and a few example requests that fill the composer.
 */
export default function JarvisWelcome({ textareaRef, setInput }: JarvisWelcomeProps) {
  const { t } = useTranslation('jarvis');

  const applyExample = (text: string) => {
    setInput(text);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg text-center">
        <img src={BRAND_LOGO} alt={PRODUCT_NAME} className="mx-auto mb-4 h-12 w-12 rounded-xl" />
        <h2 className="mb-2 text-xl font-semibold text-foreground">{t('welcome.title')}</h2>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">{t('welcome.subtitle')}</p>
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
