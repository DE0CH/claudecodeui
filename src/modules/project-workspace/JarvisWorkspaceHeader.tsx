import { useCallback, useState } from 'react';
import { FolderOpen, Share, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ShareSheet } from '@/modules/jarvis-share';
import type { Project, ProjectSession } from '@/shared/types';
import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type JarvisWorkspaceHeaderProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  isMobile: boolean;
  onMenuClick: () => void;
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
  onOpenFiles: () => void;
};

/**
 * The staff build's header (WorkspaceMain renders it instead of WorkspaceHeader): the conversation's
 * title and connection status, a Share button (the share sheet), a Files button in place of the Shell / Files / Git / Tasks tabs, and on a
 * phone a new-chat button.
 */
export default function JarvisWorkspaceHeader({
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
  onRenameSession,
  onOpenFiles,
}: JarvisWorkspaceHeaderProps) {
  const { t } = useTranslation('jarvis');
  const { handleNewSession } = useProjectCommandState();
  const [sharing, setSharing] = useState(false);
  const closeShare = useCallback(() => setSharing(false), []);

  return (
    <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
      <div className="flex min-w-0 items-center gap-2">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <WorkspaceTitle
          activeTab="chat"
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          shouldShowTasksTab={false}
          onRenameSession={onRenameSession}
        />
        <WorkspaceConnectionStatus />
        {selectedSession && (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-2.5 text-sm font-medium text-foreground hover:bg-accent sm:px-3"
            aria-label={t('share.button')}
            title={t('share.button')}
          >
            <Share className="h-4 w-4" />
            <span className="hidden sm:inline">{t('share.button')}</span>
          </button>
        )}
        {selectedSession && (
          <button
            type="button"
            onClick={onOpenFiles}
            className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-sm font-medium text-foreground hover:bg-accent"
          >
            <FolderOpen className="h-4 w-4" />
            {t('files.open')}
          </button>
        )}
        {/* On a phone the sidebar is a drawer: a new chat is one tap from the conversation. */}
        {isMobile && selectedSession && (
          <button
            type="button"
            onClick={() => handleNewSession(selectedProject)}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('sidebar.newChat')}
            title={t('sidebar.newChat')}
          >
            <SquarePen className="h-5 w-5" />
          </button>
        )}
      </div>
      {sharing && selectedSession && (
        <ShareSheet
          sessionId={selectedSession.id}
          title={selectedSession.summary || selectedSession.title}
          onClose={closeShare}
        />
      )}
    </header>
  );
}
