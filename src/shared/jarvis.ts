/**
 * Jarvis staff mode (DE0CH fork): the build that YYC's staff use, served per user by the Jarvis router.
 *
 * Switched on at build time with VITE_JARVIS=true. In this mode the app is a chat assistant only:
 * one fixed workspace (/workspace) instead of projects, no shell / git / file editor / tasks /
 * browser / plugins / worktrees / project creation, no provider login or model picker, no login
 * screen (the router in front does Cloudflare Access), no onboarding or upgrade prompts, and the
 * product carries its own name (VITE_PRODUCT_NAME, default "YYC AI").
 *
 * Without VITE_JARVIS the upstream CloudCLI behaviour is unchanged.
 */
export const IS_JARVIS = import.meta.env?.VITE_JARVIS === 'true';

/** The name staff see (title bar, sidebar, about). */
export const PRODUCT_NAME: string = (import.meta.env?.VITE_PRODUCT_NAME as string | undefined) || 'YYC AI';

/** AGPL-3.0 §13: users interacting with the app over a network can get its source here. */
export const SOURCE_URL = 'https://github.com/DE0CH/claudecodeui';

/** The one workspace every conversation runs in (each conversation's own sandbox mounts it at this path). */
export const JARVIS_WORKSPACE_PATH = '/workspace';

/** The language staff get until they pick another. */
export const JARVIS_DEFAULT_LANGUAGE = 'zh-HK';

/** The name shown wherever upstream shows "CloudCLI". */
export const BRAND_NAME = IS_JARVIS ? PRODUCT_NAME : 'CloudCLI';

/** The logo shown wherever upstream shows its own: YYC's logo (DE0CH/YYC yyc-ai/deploy/logo.svg, transparent). */
export const BRAND_LOGO = IS_JARVIS ? '/icons/jarvis-logo.svg' : '/logo.svg';

/**
 * `status` frames the Jarvis server sends while a turn waits for the conversation's sandbox (a host may be booting;
 * server/modules/jarvis/sandbox-process.ts `acquireSandboxReporting`): the first is shown as its own "preparing the
 * workspace" indicator, the second ends it (the turn then shows the usual thinking indicator).
 */
export const JARVIS_PREPARING_STATUS = 'jarvis_preparing';
export const JARVIS_READY_STATUS = 'jarvis_ready';
