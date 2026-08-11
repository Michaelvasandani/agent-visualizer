import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { constructSkillContract } from "../src/skill-contract.js";

test("resolves explicit repository references from an external Root Skill", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-contract-"),
  );
  const workingDirectory = path.join(fixtureRoot, "repository");
  const skillDirectory = path.join(fixtureRoot, "external-skill");
  const repositoryInstruction = path.join(
    workingDirectory,
    "docs",
    "agents",
    "issue-tracker.md",
  );
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await mkdir(path.dirname(repositoryInstruction), { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    "Inspect the issue tracker at `docs/agents/issue-tracker.md`.\n",
  );
  await writeFile(repositoryInstruction, "Read every requested ticket.\n");

  const contract = await constructSkillContract(
    { name: "external-skill", path: skillPath },
    workingDirectory,
  );

  assert.deepEqual(
    contract.sources.map((source) => source.path),
    [await realpath(skillPath), await realpath(repositoryInstruction)],
  );
});

test("ignores explicitly optional dangling Markdown examples in an external Root Skill", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-contract-"),
  );
  const workingDirectory = path.join(fixtureRoot, "repository");
  const skillDirectory = path.join(fixtureRoot, "external-skill");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    "Use repository standards, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`, when present.\n",
  );

  const contract = await constructSkillContract(
    { name: "external-skill", path: skillPath },
    workingDirectory,
  );

  assert.deepEqual(
    contract.sources.map((source) => source.path),
    [await realpath(skillPath)],
  );
});

test("rejects a missing required Markdown reference instead of silently weakening the contract", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-contract-"),
  );
  const workingDirectory = path.join(fixtureRoot, "repository");
  const skillDirectory = path.join(fixtureRoot, "external-skill");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    "Follow the required workflow in `docs/agents/misspelled.md`.\n",
  );

  await assert.rejects(
    constructSkillContract(
      { name: "external-skill", path: skillPath },
      workingDirectory,
    ),
    /required Markdown reference.*docs\/agents\/misspelled\.md/i,
  );
});

test("does not let an optional example hide a required reference in a later clause", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-contract-"),
  );
  const workingDirectory = path.join(fixtureRoot, "repository");
  const skillDirectory = path.join(fixtureRoot, "external-skill");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    "For example, run locally. You must follow `docs/agents/required.md`.\n",
  );

  await assert.rejects(
    constructSkillContract(
      { name: "external-skill", path: skillPath },
      workingDirectory,
    ),
    /required Markdown reference.*docs\/agents\/required\.md/i,
  );
});
