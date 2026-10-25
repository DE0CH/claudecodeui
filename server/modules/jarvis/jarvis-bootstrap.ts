/**
 * Jarvis mode start-up: the process's one user (the signed-in staff member, JARVIS_CC_OWNER) and its one project
 * (/workspace, named after the product) exist before the first request. There is no setup or sign-in screen: the
 * router in front of this process has already verified Cloudflare Access, and it is the only client.
 */
import { randomBytes } from 'node:crypto';

import { projectsDb, userDb } from '@/modules/database/index.js';
import { jarvisWorkspacePath, jarvisOwner, jarvisProductName } from '@/modules/jarvis/jarvis-config.js';

/**
 * Creates the owner's user row on first start. A different user already in this schema means the router pointed
 * this process at someone else's data: refuse to start rather than serve it.
 */
export async function ensureJarvisUser(): Promise<{ id: number; username: string }> {
  const owner = jarvisOwner();
  if (!owner) throw new Error('JARVIS_CC_OWNER must be set when JARVIS_WEB_URL is set');

  let user = await userDb.getFirstUser();
  if (!user) {
    // No password sign-in exists in this mode: the hash is a random value no password matches.
    await userDb.createUser(owner, `jarvis-no-password:${randomBytes(24).toString('hex')}`);
    user = await userDb.getFirstUser();
  }
  if (!user) throw new Error('could not create the Jarvis user');
  if (user.username.trim().toLowerCase() !== owner) {
    throw new Error(`this database schema belongs to ${user.username}, not ${owner}`);
  }
  if (!(await userDb.hasCompletedOnboarding(user.id))) {
    await userDb.completeOnboarding(user.id);
  }
  return { id: Number(user.id), username: user.username };
}

/** The one project, /workspace, active and named after the product. */
export async function ensureJarvisProject(): Promise<void> {
  const name = jarvisProductName();
  await projectsDb.createProjectPath(jarvisWorkspacePath(), name);
  const project = await projectsDb.getProjectPath(jarvisWorkspacePath());
  if (!project) throw new Error('could not create the /workspace project');
  if (project.custom_project_name !== name) {
    await projectsDb.updateCustomProjectName(jarvisWorkspacePath(), name);
  }
  if (Number(project.isArchived) === 1) {
    await projectsDb.updateProjectIsArchived(jarvisWorkspacePath(), false);
  }
}

export async function bootstrapJarvis(): Promise<void> {
  await ensureJarvisUser();
  await ensureJarvisProject();
}
