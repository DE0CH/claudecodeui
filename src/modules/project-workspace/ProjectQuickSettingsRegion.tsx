import { memo, useCallback } from 'react';

import { usePaletteOps } from '@/modules/command-palette';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SlashCommand } from '@/shared/types';
import { IS_JARVIS } from '@/shared/jarvis';

/** Rendered by ProjectWorkspaceShell to bind this module's project state and the chat composer to the quick-settings-panel module. */
function ProjectQuickSettingsRegion() {
  const { selectedProject, setActiveTab } = useProjectCommandState();
  const paletteOps = usePaletteOps();

  // A picked command belongs in the chat composer, which only accepts focus
  // while the Chat tab is showing.
  const handleInsertCommand = useCallback((command: SlashCommand) => {
    setActiveTab('chat');
    paletteOps.insertComposerText(`${command.name} `);
  }, [paletteOps, setActiveTab]);

  // Staff build: the quick-settings drawer is for developers (thinking blocks, raw tool input,
  // slash commands); the few settings staff need are in Settings.
  if (IS_JARVIS) return null;

  return (
    <QuickSettingsPanel
      selectedProject={selectedProject}
      onInsertCommand={handleInsertCommand}
    />
  );
}

export default memo(ProjectQuickSettingsRegion);
