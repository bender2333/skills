import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

const audit = join(import.meta.dir, "worktree-audit.sh");
const bashBin =
	process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
		? "C:\\Program Files\\Git\\bin\\bash.exe"
		: "bash";
const norm = (p: string) => p.replace(/\\/g, "/");
let root: string;
let repo: string;
let stubBin: string;
let env: NodeJS.ProcessEnv;
const lockedPaths: string[] = [];

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function addWorktree(name: string): string {
	const path = join(root, name);
	git(repo, "worktree", "add", "-q", "-b", name, path, "main");
	return path;
}

function runAudit(): { rows: Map<string, Record<string, string>>; stderr: string } {
	const result = spawnSync(bashBin, [audit, "-b", "main", repo], { env, encoding: "utf8" });
	expect(result.status).toBe(0);
	const lines = result.stdout.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("#"));
	const header = lines[0].split("\t");
	const rows = new Map<string, Record<string, string>>();
	for (const line of lines.slice(1)) {
		const cells = line.split("\t");
		const row = Object.fromEntries(header.map((column, i) => [column, cells[i] ?? ""]));
		rows.set(norm(row.WORKTREE), row);
	}
	return { rows, stderr: result.stderr };
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-test-")));
	repo = join(root, "repo");
	mkdirSync(repo);

	// Stub the PR CLIs so the audit never reaches a real remote.
	stubBin = join(root, "bin");
	mkdirSync(stubBin);
	for (const cli of ["origin", "gh"]) {
		const path = join(stubBin, cli);
		writeFileSync(path, "#!/bin/sh\nexit 1\n");
		chmodSync(path, 0o755);
		if (process.platform === "win32") {
			writeFileSync(join(stubBin, `${cli}.cmd`), "@echo off\r\nexit /b 1\r\n");
		}
	}

	env = {
		...process.env,
		PATH: `${stubBin}${delimiter}${process.env.PATH ?? ""}`,
		HOME: root,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};

	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "tracked.txt"), "one\n");
	git(repo, "add", "tracked.txt");
	git(repo, "commit", "-q", "-m", "initial");
});

afterAll(() => {
	for (const path of lockedPaths) {
		spawnSync("git", ["worktree", "unlock", path], { cwd: repo, env });
	}
	rmSync(root, { recursive: true, force: true });
});

test("buckets worktrees by deletion-gating state", { timeout: 30_000 }, () => {
	const locked = addWorktree("locked-wt");
	git(repo, "worktree", "lock", "--reason", "pinned by test", locked);
	lockedPaths.push(locked);

	const scratch = addWorktree("scratch-wt");
	writeFileSync(join(scratch, "untracked.txt"), "scratch\n");

	const wip = addWorktree("wip-wt");
	writeFileSync(join(wip, "tracked.txt"), "edited\n");

	const clean = addWorktree("clean-wt");

	const { rows, stderr } = runAudit();

	expect(rows.has(norm(repo))).toBe(false);

	expect(rows.get(norm(locked))?.LOCKED).toBe("pinned by test");
	expect(rows.get(norm(locked))?.INSPECT).toBe("ok");
	expect(rows.get(norm(locked))?.BUCKET).toBe("hold-locked");

	expect(rows.get(norm(scratch))?.DIRTY).toBe("scratch:1");
	expect(rows.get(norm(scratch))?.BUCKET).toBe("hold-scratch");

	expect(rows.get(norm(wip))?.DIRTY).toBe("wip:1");
	expect(rows.get(norm(wip))?.BUCKET).toBe("hold-wip");

	expect(rows.get(norm(clean))?.DIRTY).toBe("clean");
	expect(rows.get(norm(clean))?.LOCKED).toBe("-");
	expect(rows.get(norm(clean))?.MERGED).toBe("YES");
	expect(rows.get(norm(clean))?.BUCKET).toBe("safe");
});

test("a lock without a reason reports yes and holds", { timeout: 30_000 }, () => {
	const locked = addWorktree("locked-bare-wt");
	git(repo, "worktree", "lock", locked);
	lockedPaths.push(locked);

	const { rows } = runAudit();

	expect(rows.get(norm(locked))?.LOCKED).toBe("yes");
	expect(rows.get(norm(locked))?.BUCKET).toBe("hold-locked");
});
