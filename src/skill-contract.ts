import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface RootSkillSelection {
  readonly name: string;
  readonly path: string;
}

export type SkillAttribution =
  | {
      readonly kind: "exact" | "confirmed";
      readonly rootSkill: RootSkillSelection;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: string;
    };

export interface SkillContractSource {
  readonly path: string;
  readonly instructions: string;
}

export interface SkillContract {
  readonly rootSkill: RootSkillSelection;
  readonly sources: readonly SkillContractSource[];
}

const FINAL_RESULT_SECTION =
  /^(?:(?:final\s+)?(?:answer|response|result|deliverable)(?:\s+(?:quality|style|format(?:ting)?))?|output|style|formatting|writing\s+style)$/i;
const FINAL_RESULT_SUBJECT =
  /\b(?:final\s+(?:answer|response|result|output)|deliverable)\b/i;
const QUALITY_DIRECTIVE =
  /^(?:be|format|keep|make|write)\b[^.]*\b(?:clear|concise|elegant|polished|professional|readable|well[- ]written)\b/i;
const EXECUTION_MODAL =
  /\b(?:must|should|shall|will|need(?:s)? to|required to|do not|don't|never)\b/i;
const DECLARATIVE_OPENING =
  /^(?:a|an|it|that|the|there|these|this|those)\b/i;

export async function constructSkillContract(
  rootSkill: RootSkillSelection,
  workingDirectory?: string,
): Promise<SkillContract> {
  const pendingPaths = [rootSkill.path];
  const visitedPaths = new Set<string>();
  const sources: SkillContractSource[] = [];

  while (pendingPaths.length > 0) {
    const requestedPath = pendingPaths.shift();
    if (requestedPath === undefined) break;
    if (!path.isAbsolute(requestedPath)) {
      throw new Error(
        `Skill Contract source paths must be absolute: ${requestedPath}`,
      );
    }

    const sourcePath = await realpath(requestedPath);
    if (visitedPaths.has(sourcePath)) continue;
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile() || path.extname(sourcePath).toLowerCase() !== ".md") {
      throw new Error(
        `Skill Contract sources must be regular Markdown files: ${sourcePath}`,
      );
    }

    visitedPaths.add(sourcePath);
    const sourceText = await readFile(sourcePath, "utf8");
    const instructions = executionInstructions(sourceText);
    sources.push(Object.freeze({ path: sourcePath, instructions }));

    for (const reference of explicitFileReferences(stripFrontmatter(sourceText))) {
      const referencePath = await resolveReferencePath(
        reference,
        sourcePath,
        workingDirectory,
      );
      if (referencePath !== undefined) pendingPaths.push(referencePath);
    }
  }

  return Object.freeze({
    rootSkill: Object.freeze({ ...rootSkill }),
    sources: Object.freeze(sources),
  });
}

async function resolveReferencePath(
  reference: string,
  sourcePath: string,
  workingDirectory: string | undefined,
): Promise<string | undefined> {
  if (path.isAbsolute(reference)) {
    return (await pathExists(reference)) ? reference : undefined;
  }
  const sourceRelativePath = path.resolve(path.dirname(sourcePath), reference);
  if (await pathExists(sourceRelativePath)) return sourceRelativePath;
  if (workingDirectory === undefined) return undefined;
  const repositoryRelativePath = path.resolve(workingDirectory, reference);
  return (await pathExists(repositoryRelativePath))
    ? repositoryRelativePath
    : undefined;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

export function renderSkillContract(contract: SkillContract): readonly string[] {
  const lines = [
    `[Skill Contract] Root Skill=${JSON.stringify(contract.rootSkill.name)} path=${contract.rootSkill.path}`,
  ];
  contract.sources.forEach((source, index) => {
    lines.push(
      `[Skill Contract source ${index + 1}] ${source.path}\n${source.instructions}`,
    );
  });
  return lines;
}

function executionInstructions(markdown: string): string {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let finalResultAtLevel: number | null = null;

  const flushBlock = (): void => {
    const block = currentBlock.join("\n").trim();
    currentBlock = [];
    if (
      block !== "" &&
      !isFinalResultQuality(block, finalResultAtLevel !== null) &&
      isExecutionRequirement(block)
    ) {
      blocks.push(block);
    }
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      flushBlock();
      const level = heading[1]?.length ?? 1;
      if (finalResultAtLevel !== null && level <= finalResultAtLevel) {
        finalResultAtLevel = null;
      }
      if (FINAL_RESULT_SECTION.test(heading[2]?.trim() ?? "")) {
        finalResultAtLevel = level;
      }
      continue;
    }
    if (line.trim() === "") {
      flushBlock();
    } else {
      currentBlock.push(line);
    }
  }
  flushBlock();

  return blocks.join("\n\n");
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function isExecutionRequirement(block: string): boolean {
  const normalized = plainInstructionText(block);
  if (normalized === "" || /:\s*$/.test(normalized)) return false;
  if (EXECUTION_MODAL.test(normalized)) return true;
  if (/^(?:after|before|if|once|when|whenever|while)\b/i.test(normalized)) {
    return true;
  }
  if (DECLARATIVE_OPENING.test(normalized)) return false;
  if (/^[\p{L}\d_-]+\s+(?:is|are|was|were|has|have|had)\b/iu.test(normalized)) {
    return false;
  }
  return true;
}

function isFinalResultQuality(
  block: string,
  inFinalResultSection: boolean,
): boolean {
  if (inFinalResultSection) return true;
  const normalized = plainInstructionText(block);
  const conditionalAction =
    /^(?:after|before|if|once|when|whenever|while)\b[^,]*,\s*(.+)$/i.exec(
      normalized,
    )?.[1];
  if (
    conditionalAction !== undefined &&
    !FINAL_RESULT_SUBJECT.test(conditionalAction)
  ) {
    return false;
  }
  return (
    FINAL_RESULT_SUBJECT.test(normalized) || QUALITY_DIRECTIVE.test(normalized)
  );
}

function plainInstructionText(block: string): string {
  return block
    .replace(/^\s*(?:[-*+] |\d+[.)] )/, "")
    .replace(/^\*\*[^*]+\*\*[.:]?\s*/, "")
    .trim();
}

function explicitFileReferences(markdown: string): readonly string[] {
  const references = new Set<string>();
  const links = /(?<!!)\[[^\]]*]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(links)) {
    addLocalMarkdownReference(references, markdownLinkTarget(match[1] ?? ""));
  }
  for (const match of markdown.matchAll(/^\s*\[[^\]]+]:\s*(\S+)/gm)) {
    addLocalMarkdownReference(references, match[1] ?? "");
  }
  for (const match of markdown.matchAll(/`([^`\r\n]+\.md(?:[?#][^`\r\n]*)?)`/gi)) {
    addLocalMarkdownReference(references, match[1] ?? "");
  }
  for (const match of markdown.matchAll(
    /(?:^|[\s("'=])((?:\.{1,2}\/|\/)?[a-z\d_./-]+\.md)(?=$|[\s)"',:;])/gim,
  )) {
    addLocalMarkdownReference(references, match[1] ?? "");
  }
  return [...references];
}

function markdownLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith("<")) return trimmed.slice(1, trimmed.indexOf(">"));
  return trimmed.split(/\s+/, 1)[0] ?? "";
}

function addLocalMarkdownReference(
  references: Set<string>,
  rawTarget: string,
): void {
  const target = rawTarget.trim();
  if (target === "" || target.startsWith("#")) return;
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return;
  const withoutFragment = target.split(/[?#]/, 1)[0];
  if (withoutFragment?.toLowerCase().endsWith(".md")) {
    references.add(decodeURIComponent(withoutFragment));
  }
}
