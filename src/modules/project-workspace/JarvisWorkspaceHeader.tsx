import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectSession } from '@/shared/types';
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
 * title and connection status, and a Files button in place of the Shell / Files / Git / Tasks tabs.
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
            onClick={onOpenFiles}
            className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-sm font-medium text-foreground hover:bg-accent"
          >
            <FolderOpen className="h-4 w-4" />
            {t('files.open')}
          </button>
        )}
      </div>
    </header>
  );
}
