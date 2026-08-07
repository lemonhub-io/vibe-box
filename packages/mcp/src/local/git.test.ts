import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GitRunner } from "./git.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: dir });
  return dir;
}

describe("GitRunner", () => {
  it("detects a repository", async () => {
    const dir = await makeRepo();
    try {
      expect(await new GitRunner(dir).isRepo()).toBe(true);
      expect(await new GitRunner(join(dir, "..")).isRepo()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports status and commits all changes", async () => {
    const dir = await makeRepo();
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "a.txt"), "hello\n");
      const runner = new GitRunner(dir);
      expect(await runner.status()).toContain("a.txt");
      const out = await runner.commitAll("add a.txt");
      expect(out).toContain("add a.txt");
      expect((await runner.status()).trim()).toBe("");
      expect(await runner.log(3)).toContain("add a.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pushes to and pulls from a bare remote", async () => {
    const dir = await makeRepo();
    const bare = await makeBareRemote();
    try {
      const runner = new GitRunner(dir);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "b.txt"), "x\n");
      await runner.commitAll("add b.txt");
      execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
      await runner.push();
      const cloneDir = await mkdtemp(join(tmpdir(), "vibe-clone-"));
      try {
        execFileSync("git", ["clone", bare, cloneDir], { stdio: "pipe" });
        // A clone does not inherit identity config; host-side setup
        // is a documented prerequisite, so tests provide it.
        execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: cloneDir });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
        const cloneRunner = new GitRunner(cloneDir);
        expect(await cloneRunner.log(3)).toContain("add b.txt");
        await writeFile(join(cloneDir, "c.txt"), "y\n");
        await cloneRunner.commitAll("add c.txt");
        await cloneRunner.push();
        await runner.pull();
        expect(await runner.log(3)).toContain("add c.txt");
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });
});
