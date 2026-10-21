import path from "node:path";
import fs from "node:fs/promises";
import { simpleGit, SimpleGit } from "simple-git";

export interface WorktreeSession {
  id: string;
  devId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
}

export class WorktreeManager {
  private repoRoot: string;
  private worktreesDir: string;
  private git: SimpleGit;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.worktreesDir = path.join(this.repoRoot, ".worktrees");
    this.git = simpleGit(this.repoRoot);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.worktreesDir, { recursive: true });
  }

  async createSession(devId: string, taskId: string): Promise<WorktreeSession> {
    const sessionId = `${devId}-${taskId}-${Date.now().toString().slice(-4)}`;
    const branch = `agent/${sessionId}`;
    const worktreePath = path.join(this.worktreesDir, sessionId);

    // Create worktree on a new branch derived from HEAD
    await this.git.raw(["worktree", "add", "-b", branch, worktreePath, "HEAD"]);

    return {
      id: sessionId,
      devId,
      taskId,
      branch,
      worktreePath,
      createdAt: new Date().toISOString(),
    };
  }

  async listSessions(): Promise<string[]> {
    const output = await this.git.raw(["worktree", "list"]);
    return output.trim().split("\n");
  }

  async getDiff(worktreePath: string): Promise<string> {
    const sessionGit = simpleGit(worktreePath);
    return await sessionGit.diff(["HEAD~1"]);
  }

  async removeSession(session: WorktreeSession): Promise<void> {
    await this.git.raw(["worktree", "remove", "--force", session.worktreePath]);
  }
}
