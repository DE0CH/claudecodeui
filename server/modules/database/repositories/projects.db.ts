import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { all, get, run, transaction } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    async createProjectPath(projectPath: string, customProjectName: string | null = null): Promise<CreateProjectPathResult> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = (await get(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived
        `, [attemptedId, normalizedProjectPath, normalizedProjectName])) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = await projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    async getProjectPath(projectPath: string): Promise<ProjectRepositoryRow | null> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = (await get(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE project_path = ?
        `, [normalizedProjectPath])) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    async getProjectById(projectId: string): Promise<ProjectRepositoryRow | null> {
        const row = (await get(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE project_id = ?
        `, [projectId])) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    async getProjectPathById(projectId: string): Promise<string | null> {
        const row = (await get(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `, [projectId])) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    async getProjectPaths(): Promise<ProjectRepositoryRow[]> {
        return (await all(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE isArchived = 0
        `)) as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     */
    async getArchivedProjectPaths(): Promise<ProjectRepositoryRow[]> {
        return (await all(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE isArchived = 1
        `)) as ProjectRepositoryRow[];
    },

    async getCustomProjectName(projectPath: string): Promise<string | null> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = (await get(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `, [normalizedProjectPath])) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    async updateCustomProjectName(projectPath: string, customProjectName: string | null): Promise<void> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        (await run(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `, [randomUUID(), normalizedProjectPath, customProjectName]));
    },

    async updateCustomProjectNameById(projectId: string, customProjectName: string | null): Promise<void> {
        (await run(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `, [customProjectName, projectId]));
    },

    async updateProjectIsStarred(projectPath: string, isStarred: boolean): Promise<void> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        (await run(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `, [isStarred ? 1 : 0, normalizedProjectPath]));
    },

    async updateProjectIsStarredById(projectId: string, isStarred: boolean): Promise<void> {
        (await run(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `, [isStarred ? 1 : 0, projectId]));
    },

    async updateProjectIsArchived(projectPath: string, isArchived: boolean): Promise<void> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        (await run(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `, [isArchived ? 1 : 0, normalizedProjectPath]));
    },

    async updateProjectIsArchivedById(projectId: string, isArchived: boolean): Promise<void> {
        (await run(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `, [isArchived ? 1 : 0, projectId]));
    },

    async deleteProjectPath(projectPath: string): Promise<void> {
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        (await run(`
            DELETE FROM projects
            WHERE project_path = ?
        `, [normalizedProjectPath]));
    },

    async deleteProjectById(projectId: string): Promise<void> {
        (await run(`
            DELETE FROM projects
            WHERE project_id = ?
        `, [projectId]));
    },
};
