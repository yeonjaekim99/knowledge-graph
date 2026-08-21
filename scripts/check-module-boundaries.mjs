#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");

function toPosix(path) {
  return path.split(sep).join("/");
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function collectTypeScriptFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

function readConfig(projectRoot, configPath) {
  const absolutePath = resolve(
    projectRoot,
    configPath ?? "architecture.config.json",
  );
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function scanTokens(text) {
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  const tokens = [];

  for (
    let kind = scanner.scan();
    kind !== SyntaxKind.EndOfFile;
    kind = scanner.scan()
  ) {
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
    });
  }

  return tokens;
}

function moduleReferences(text) {
  const references = [];
  const tokens = scanTokens(text);

  function addReference(token, kind) {
    if (token?.kind === SyntaxKind.StringLiteral) {
      references.push({ kind, specifier: token.value });
    } else {
      references.push({ kind, specifier: undefined });
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (token.kind === SyntaxKind.ImportKeyword) {
      if (next?.kind === SyntaxKind.OpenParenToken) {
        addReference(tokens[index + 2], "dynamic import");
        continue;
      }

      if (next?.kind === SyntaxKind.StringLiteral) {
        addReference(next, "import");
        continue;
      }

      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.kind === SyntaxKind.SemicolonToken) {
          break;
        }
        if (candidate.kind === SyntaxKind.FromKeyword) {
          addReference(tokens[cursor + 1], "import");
          break;
        }
      }
    } else if (token.kind === SyntaxKind.ExportKeyword) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.kind === SyntaxKind.SemicolonToken) {
          break;
        }
        if (candidate.kind === SyntaxKind.FromKeyword) {
          addReference(tokens[cursor + 1], "export");
          break;
        }
      }
    } else if (
      token.kind === SyntaxKind.Identifier &&
      token.value === "require" &&
      next?.kind === SyntaxKind.OpenParenToken
    ) {
      addReference(tokens[index + 2], "require");
    }
  }

  return references;
}

function forbiddenRuntimeReferences(text, layer) {
  const identifiers = new Set(layer.forbiddenIdentifiers ?? []);
  const memberAccess = new Set(layer.forbiddenMemberAccess ?? []);
  if (identifiers.size === 0 && memberAccess.size === 0) {
    return [];
  }

  const references = [];
  const tokens = scanTokens(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.kind === SyntaxKind.Identifier &&
      identifiers.has(token.value)
    ) {
      references.push(token.value);
    }

    if (
      token.kind === SyntaxKind.Identifier &&
      tokens[index + 1]?.kind === SyntaxKind.DotToken &&
      tokens[index + 2]?.kind === SyntaxKind.Identifier
    ) {
      const reference = `${token.value}.${tokens[index + 2].value}`;
      if (memberAccess.has(reference)) {
        references.push(reference);
      }
    }
  }
  return [...new Set(references)].sort();
}

function resolveInternalImport(fromFile, specifier) {
  const unresolved = resolve(dirname(fromFile), specifier);
  const extension = extname(unresolved);
  const candidates = [];

  if (extension === ".js") {
    candidates.push(unresolved.slice(0, -3) + ".ts");
  } else if (extension === ".mjs") {
    candidates.push(unresolved.slice(0, -4) + ".mts");
  } else if (extension === ".cjs") {
    candidates.push(unresolved.slice(0, -4) + ".cts");
  } else if (extension) {
    candidates.push(unresolved);
  } else {
    candidates.push(
      `${unresolved}.ts`,
      `${unresolved}.mts`,
      resolve(unresolved, "index.ts"),
      resolve(unresolved, "index.mts"),
    );
  }

  return candidates.find((candidate) => existsSync(candidate));
}

function allowsExternal(specifier, allowedPackages) {
  return allowedPackages.some((allowed) =>
    allowed.endsWith(":")
      ? specifier.startsWith(allowed)
      : specifier === allowed || specifier.startsWith(`${allowed}/`),
  );
}

function layerFor(relativePath, config) {
  if (relativePath === config.publicEntry) {
    return {
      name: "public-entry",
      ...config.publicEntryRule,
    };
  }

  return config.layers.find(
    ({ root }) => relativePath === root || relativePath.startsWith(`${root}/`),
  );
}

function isPrivatePublicTarget(relativePath, config) {
  return config.privatePublicTargets.some(
    (target) => relativePath === target || relativePath.startsWith(`${target}/`),
  );
}

function validateAtomicWritePort(projectRoot, config, errors) {
  const contract = config.atomicWritePort;
  const path = resolve(projectRoot, contract.file);
  if (!existsSync(path)) {
    return;
  }

  const tokens = scanTokens(readFileSync(path, "utf8"));
  const interfaceIndex = tokens.findIndex(
    (token, index) =>
      token.kind === SyntaxKind.InterfaceKeyword &&
      tokens[index + 1]?.kind === SyntaxKind.Identifier &&
      tokens[index + 1]?.value === contract.interface,
  );

  if (interfaceIndex === -1) {
    errors.push(
      `${contract.file}: missing atomic write interface ${contract.interface}`,
    );
    return;
  }

  const openingBraceIndex = tokens.findIndex(
    (token, index) =>
      index > interfaceIndex && token.kind === SyntaxKind.OpenBraceToken,
  );
  if (openingBraceIndex === -1) {
    errors.push(`${contract.file}: malformed ${contract.interface} interface`);
    return;
  }

  let depth = 1;
  let parenthesisDepth = 0;
  const members = [];
  for (let index = openingBraceIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.OpenBraceToken) {
      depth += 1;
      continue;
    }
    if (token.kind === SyntaxKind.CloseBraceToken) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      continue;
    }
    if (token.kind === SyntaxKind.OpenParenToken) {
      parenthesisDepth += 1;
      continue;
    }
    if (token.kind === SyntaxKind.CloseParenToken) {
      parenthesisDepth -= 1;
      continue;
    }
    if (
      depth === 1 &&
      parenthesisDepth === 0 &&
      token.kind === SyntaxKind.Identifier &&
      [
        SyntaxKind.OpenParenToken,
        SyntaxKind.ColonToken,
        SyntaxKind.QuestionToken,
      ].includes(tokens[index + 1]?.kind)
    ) {
      members.push({ name: token.value, separator: tokens[index + 1].kind });
    }
  }

  if (
    members.length !== 1 ||
    members[0].name !== contract.method ||
    members[0].separator !== SyntaxKind.OpenParenToken
  ) {
    errors.push(
      `${contract.file}: ${contract.interface} must expose only ${contract.method}()`,
    );
  }
}

export function validateArchitecture({
  projectRoot = DEFAULT_PROJECT_ROOT,
  configPath,
} = {}) {
  const root = resolve(projectRoot);
  const config = readConfig(root, configPath);
  const sourceRoot = resolve(root, config.sourceRoot);
  const errors = [];

  for (const requiredFile of config.requiredFiles) {
    if (!existsSync(resolve(root, requiredFile))) {
      errors.push(`${requiredFile}: required architecture entrypoint is missing`);
    }
  }

  const files = collectTypeScriptFiles(sourceRoot);
  for (const file of files) {
    const relativeFile = toPosix(relative(root, file));
    const sourceLayer = layerFor(relativeFile, config);
    if (!sourceLayer) {
      errors.push(`${relativeFile}: file does not belong to a declared layer`);
      continue;
    }

    const sourceText = readFileSync(file, "utf8");
    for (const reference of forbiddenRuntimeReferences(
      sourceText,
      sourceLayer,
    )) {
      errors.push(
        `${relativeFile}: ${sourceLayer.name} may not reference runtime global ${reference}`,
      );
    }

    for (const reference of moduleReferences(sourceText)) {
      const { kind, specifier } = reference;
      if (specifier === undefined) {
        errors.push(`${relativeFile}: ${kind} must use a string literal`);
        continue;
      }

      const normalizedSpecifier = specifier.replaceAll("\\", "/");
      if (
        config.forbiddenImportFragments.some((fragment) =>
          normalizedSpecifier.includes(fragment),
        )
      ) {
        errors.push(`${relativeFile}: forbidden spike import ${specifier}`);
        continue;
      }

      if (specifier.startsWith(".")) {
        const target = resolveInternalImport(file, specifier);
        if (!target) {
          errors.push(`${relativeFile}: unresolved ${kind} ${specifier}`);
          continue;
        }
        if (!isInside(sourceRoot, target)) {
          errors.push(`${relativeFile}: source import escapes src: ${specifier}`);
          continue;
        }

        const relativeTarget = toPosix(relative(root, target));
        const targetLayer = layerFor(relativeTarget, config);
        if (!targetLayer) {
          errors.push(`${relativeFile}: target has no declared layer: ${specifier}`);
          continue;
        }
        if (!sourceLayer.mayImport.includes(targetLayer.name)) {
          errors.push(
            `${relativeFile}: ${sourceLayer.name} may not import ${targetLayer.name} (${specifier})`,
          );
        }
        if (
          config.publicApiFiles.includes(relativeFile) &&
          isPrivatePublicTarget(relativeTarget, config)
        ) {
          errors.push(
            `${relativeFile}: public API may not reference private target ${specifier}`,
          );
        }
      } else if (
        specifier.startsWith("/") ||
        !allowsExternal(specifier, sourceLayer.externalPackages)
      ) {
        errors.push(
          `${relativeFile}: ${sourceLayer.name} may not import package ${specifier}`,
        );
      }
    }
  }

  validateAtomicWritePort(root, config, errors);

  return {
    errors: errors.sort(),
    filesChecked: files.length,
    layerCount: config.layers.length + 1,
  };
}

function runCli() {
  const result = validateArchitecture();
  if (result.errors.length > 0) {
    console.error("architecture_check=FAIL");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`source_files=${result.filesChecked}`);
  console.log(`layers=${result.layerCount}`);
  console.log("atomic_write_port=appendAndProject_only");
  console.log("domain_runtime_globals=forbidden");
  console.log("spike_imports=forbidden");
  console.log("architecture_check=PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
