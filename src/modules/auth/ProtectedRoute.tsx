import type { ReactNode } from 'react';

import { IS_JARVIS } from '@/shared/jarvis';
import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';
import { JarvisHealthGate } from '@/modules/jarvis-health';

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (IS_JARVIS) {
    // The router in front does sign-in; the gate shows why the app can't work (signed out, not allowed, server
    // unreachable) instead of an endless loading screen or an empty list
    return <JarvisHealthGate loading={<AuthLoadingScreen />}>{isLoading ? <AuthLoadingScreen /> : children}</JarvisHealthGate>;
  }

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    // Staff never see the onboarding wizard: it sets up git identity and agent logins, which the
    // staff build has no use for.
    if (!IS_JARVIS && !hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
