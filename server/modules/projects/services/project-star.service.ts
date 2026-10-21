import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type ToggleProjectStarResult = {
  isStarred: boolean;
};

type ApplyLegacyStarredProjectIdsResult = {
  updated: number;
};

function normalizeProjectId(projectId: string): string {
  return projectId.trim();
}

function uniqueProjectIds(projectIds: string[]): string[] {
  const uniqueIds = new Set<string>();
  for (const projectId of projectIds) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) {
      continue;
    }
    uniqueIds.add(normalizedProjectId);
  }
  return [...uniqueIds];
}

/**
 * Applies legacy `localStorage` stars keyed by DB `projectId` onto `projects.isStarred`.
 *
 * The operation is idempotent: already-starred projects are ignored, unknown ids are skipped.
 */
export async function applyLegacyStarredProjectIds(projectIds: string[]): Promise<ApplyLegacyStarredProjectIdsResult> {
  const normalizedProjectIds = uniqueProjectIds(projectIds);
  let updated = 0;

  for (const projectId of normalizedProjectIds) {
    const project = await projectsDb.getProjectById(projectId);
    if (!project) {
      continue;
    }

    if (project.isStarred) {
      continue;
    }

    await projectsDb.updateProjectIsStarredById(projectId, true);
    updated += 1;
  }

  return { updated };
}

/**
 * Flips `projects.isStarred` for one project and returns the new state.
 */
export async function toggleProjectStar(projectId: string): Promise<ToggleProjectStarResult> {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    throw new AppError('projectId is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const project = await projectsDb.getProjectById(normalizedProjectId);
  if (!project) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const nextStarredState = !project.isStarred;
  await projectsDb.updateProjectIsStarredById(normalizedProjectId, nextStarredState);

  return { isStarred: nextStarredState };
}
