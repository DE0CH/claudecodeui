import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { BRAND_LOGO, PRODUCT_NAME } from '@/shared/jarvis';
import { GREETING_DRAW, greeting, greetingLocale, returningUser } from '@/modules/chat/utils/jarvisGreeting';

type JarvisWelcomeProps = {
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


/**
 * The staff build's empty chat (ChatMessagesPane renders it instead of the provider picker): there is
 * one assistant, so YYC's logo and a time-of-day greeting (utils/jarvisGreeting.ts), as in the old YYC AI UI (no
 * example prompts: Deyao, 2026-10-21).
 */
export default function JarvisWelcome({ hasEarlierConversations }: JarvisWelcomeProps) {
  const { i18n } = useTranslation('jarvis');
  // undefined until the router has answered: the heading stays blank meanwhile, so it never swaps
  const [firstName, setFirstName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadFirstName().then((n) => { if (live) setFirstName(n); });
    return () => { live = false; };
  }, []);
  const returning = returningUser(hasEarlierConversations);

  // the old YYC AI UI's empty screen, exactly: a 640 px column, the logo and the greeting, left-aligned, nothing else
  return (
    <div className="mx-auto w-full max-w-[640px] px-5 pb-6 pt-[max(48px,12vh)]">
      <img src={BRAND_LOGO} alt={PRODUCT_NAME} className="h-12 w-12 rounded-[13px] object-contain" />
      <h2 className="mb-2 mt-[18px] text-[clamp(24px,4.5vw,30px)] font-bold leading-[1.25] tracking-[-0.01em] text-foreground">
        {firstName === undefined
          ? '\u00a0'
          : greeting(greetingLocale(i18n.language), new Date(), GREETING_DRAW, firstName, returning)}
      </h2>
    </div>
  );
}
