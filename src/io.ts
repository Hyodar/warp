import * as path from 'path';
import * as fs from 'fs/promises';
import { OutputOptions, TranspilationOptions } from './cli';
import { TranspileFailedError, logError } from './utils/errors';
import { AST } from './ast/ast';
import { outputFile, pathExists } from './utils/fs';

export async function isValidSolFile(path: string, printError = true): Promise<boolean> {
  if (!(await pathExists(path))) {
    if (printError) logError(`${path} doesn't exist`);
    return false;
  }

  if (!(await fs.lstat(path)).isFile()) {
    if (printError) logError(`${path} is not a file`);
    return false;
  }

  if (!path.endsWith('.sol')) {
    if (printError) logError(`${path} is not a solidity source file`);
    return false;
  }

  return true;
}

export async function findSolSourceFilePaths(
  targetPath: string,
  recurse: boolean,
): Promise<string[]> {
  return (await findAllFiles(targetPath, recurse)).filter((path) => path.endsWith('.sol'));
}

export async function findCairoSourceFilePaths(
  targetPath: string,
  recurse: boolean,
): Promise<string[]> {
  return (await findAllFiles(targetPath, recurse)).filter((path) => path.endsWith('.cairo'));
}

export async function findAllFiles(targetPath: string, recurse: boolean): Promise<string[]> {
  const targetInformation = await fs.lstat(targetPath);
  if (targetInformation.isDirectory()) {
    return evaluateDirectory(targetPath, recurse);
  } else if (targetInformation.isFile()) {
    return [targetPath];
  } else {
    console.log(`WARNING: Found ${targetPath}, which is neither a file nor directory`);
    return [];
  }
}

async function evaluateDirectory(path: string, recurse: boolean): Promise<string[]> {
  const dirEntries = await fs.readdir(path, { withFileTypes: true });

  return (
    await Promise.all(
      dirEntries.map(async (dirEntry) => {
        if (!recurse && dirEntry.isDirectory()) {
          return [];
        }

        return await findAllFiles(`${path}/${dirEntry.name}`, recurse);
      }),
    )
  ).flat();
}

export function replaceSuffix(filePath: string, suffix: string): string {
  const parsedPath = path.parse(filePath);
  return path.join(parsedPath.dir, `${parsedPath.name}${suffix}`);
}

export async function outputResult(
  contractName: string,
  outputPath: string,
  code: string,
  options: OutputOptions & TranspilationOptions,
  ast: AST,
): Promise<void> {
  if (options.outputDir !== undefined) {
    if (await pathExists(options.outputDir)) {
      const targetInformation = await fs.lstat(options.outputDir);

      if (!targetInformation.isDirectory()) {
        throw new TranspileFailedError(
          `Cannot output to ${options.outputDir}. Output-dir must be a directory`,
        );
      }
    }

    const fullCodeOutPath = path.join(options.outputDir, outputPath);
    const abiOutPath = fullCodeOutPath.slice(0, -'.cairo'.length).concat('_sol_abi.json');

    const solFilePath = path.dirname(outputPath);

    await Promise.all([
      outputFile(
        abiOutPath,
        JSON.stringify(ast.solidityABI.contracts[solFilePath][contractName]['abi'], null, 2),
      ),
      outputFile(fullCodeOutPath, code),
    ]);

    // Cairo-format is disabled, as it has a bug
    // if (options.formatCairo || options.dev) {
    //   const warpVenvPrefix = `PATH=${path.resolve(__dirname, '..', 'warp_venv', 'bin')}:$PATH`;
    //   execSync(`${warpVenvPrefix} cairo-format -i ${fullCodeOutPath}`);
    // }
  } else {
    console.log(`//--- ${outputPath} ---\n${code}\n//---`);
  }
}
