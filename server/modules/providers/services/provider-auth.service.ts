import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { jarvisEnabled, jarvisOwner } from '@/modules/jarvis/jarvis-config.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    // Jarvis mode: Claude Code runs in the sandbox and egress holds the API key, so it is always set up and signed
    // in; nothing on this host (CLI install, credentials) matters.
    if (jarvisEnabled()) {
      return { installed: true, provider: provider.id, authenticated: true, email: jarvisOwner() || null, method: 'jarvis' };
    }
    return provider.auth.getStatus();
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};
