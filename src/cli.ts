import * as fs from 'fs/promises';
import * as path from 'path';
import util from 'util';
import { exec } from 'child_process';
import { parse } from 'path';
import { Command } from 'commander';
import { isValidSolFile, outputResult, replaceSuffix } from './io';
import { compileSolFiles } from './solCompile';
import { handleTranspilationError, transform, transpile } from './transpiler';
import { analyseSol } from './utils/analyseSol';
import {
  enqueueCompileCairo,
  runStarknetCallOrInvoke,
  runStarknetCompile,
  runStarknetDeclare,
  runStarknetDeploy,
  runStarknetDeployAccount,
  runStarknetNewAccount,
  runStarknetStatus,
} from './starknetCli';
import chalk from 'chalk';
import { runVenvSetup } from './utils/setupVenv';

import { generateSolInterface } from './icf/interfaceCallForwarder';
import { postProcessCairoFile } from './utils/postCairoWrite';
import { defaultBasePathAndIncludePath } from './utils/utils';

export type CompilationOptions = {
  warnings?: boolean;
  includePaths?: string[];
  basePath?: string;
};

export type TranspilationOptions = {
  checkTrees?: boolean;
  dev: boolean;
  order?: string;
  printTrees?: boolean;
  strict?: boolean;
  warnings?: boolean;
  until?: string;
};

export type PrintOptions = {
  highlight?: string[];
  stubs?: boolean;
};

export type OutputOptions = {
  compileCairo?: boolean;
  outputDir: string;
  formatCairo: boolean;
};

type CliOptions = CompilationOptions &
  TranspilationOptions &
  PrintOptions &
  OutputOptions &
  IOptionalDebugInfo;

export const program = new Command();

program
  .command('transpile <files...>')
  .description('Transpile Solidity contracts into Cairo contracts')
  .option('--compile-cairo', 'Compile the output to bytecode')
  .option('--check-trees', 'Debug: Run sanity checks on all intermediate ASTs')
  // for development mode
  .option('--dev', 'Run AST sanity checks on every pass instead of the final AST only', false)
  .option('--format-cairo', 'Format the cairo output - can be slow on large contracts')
  .option(
    '--highlight <ids...>',
    'Debug: Highlight selected ids in the AST printed by --print-trees',
  )
  .option('--order <passOrder>', 'Use a custom set of transpilation passes')
  .option('-o, --output-dir <path>', 'Output directory for transpiled Cairo files.', 'warp_output')
  .option(
    '-d, --debug-info',
    'Include debug information in the compiled bytecode produced by --compile-cairo',
    false,
  )
  .option('--print-trees', 'Debug: Print all the intermediate ASTs')
  .option('--no-stubs', 'Debug: Hide the stubs in the intermediate ASTs when using --print-trees')
  .option('--no-strict', 'Debug: Allow silent failure of AST consistency checks')
  .option('--until <pass>', 'Stops transpilation after the specified pass')
  .option('--no-warnings', 'Suppress warnings from the Solidity compiler')
  .option('--include-paths <paths...>', 'Pass through to solc --include-path option')
  .option('--base-path <path>', 'Pass through to solc --base-path option')
  .action(runTranspile);

export async function runTranspile(files: string[], options: CliOptions) {
  // We do the extra work here to make sure all the errors are printed out
  // for all files which are invalid.
  if ((await Promise.all(files.map((file) => isValidSolFile(file)))).some((result) => !result))
    return;

  const [defaultBasePath, defaultIncludePath] = await defaultBasePathAndIncludePath();

  if (defaultBasePath !== null && defaultIncludePath !== null) {
    options.includePaths =
      options.includePaths === undefined
        ? [defaultIncludePath]
        : options.includePaths.concat(defaultIncludePath);
    options.basePath = options.basePath || defaultBasePath;
  }

  // map file location relative to current working directory
  const mFiles = files.map((file) => path.relative(process.cwd(), file));
  const ast = await compileSolFiles(mFiles, options);

  try {
    const transpiledContracts = await transpile(ast, options);

    await Promise.all(
      transpiledContracts.map(async ([fname, cairo]) => {
        await outputResult(parse(fname).name, fname, cairo, options, ast);
      }),
    );

    const contractToHashMap = new Map<string, Promise<string>>();

    await Promise.all(
      transpiledContracts.map(async ([fname]) => {
        await postProcessCairoFile(fname, options.outputDir, options.debugInfo, contractToHashMap);

        if (options.compileCairo) {
          const { success, resultPath, abiPath } = await enqueueCompileCairo(
            path.join(options.outputDir, fname),
            path.resolve(__dirname, '..'),
            options,
          );

          if (!success) {
            if (resultPath) {
              await fs.unlink(resultPath);
            }
            if (abiPath) {
              await fs.unlink(abiPath);
            }
          }
        }
      }),
    );
  } catch (e) {
    handleTranspilationError(e);
  }
}

program
  .command('transform <file>')
  .description(
    'Debug tool which applies any set of passes to the AST and writes out the transformed Solidity',
  )
  .option('--check-trees', 'Debug: Run sanity checks on all intermediate ASTs')
  .option(
    '--highlight <ids...>',
    'Debug: highlight selected ids in the AST printed by --print-trees',
  )
  .option('--order <passOrder>', 'Use a custom set of transpilation passes')
  .option('-o, --output-dir <path>', 'Output directory for transformed Solidity files')
  .option('--print-trees', 'Debug: Print all the intermediate ASTs')
  .option('--no-stubs', 'Debug: Hide the stubs in the intermediate ASTs when using --print-trees')
  .option('--no-strict', 'Debug: Allow silent failure of AST consistency checks')
  .option('--until <pass>', 'Stop processing at specified pass')
  .option('--no-warnings', 'Suppress printed warnings')
  .option('--include-paths <paths...>', 'Pass through to solc --include-path option')
  .option('--base-path <path>', 'Pass through to solc --base-path option')
  .action(runTransform);

export async function runTransform(file: string, options: CliOptions) {
  if (!isValidSolFile(file)) return;

  const [defaultBasePath, defaultIncludePath] = await defaultBasePathAndIncludePath();

  if (defaultBasePath !== null && defaultIncludePath !== null) {
    options.includePaths =
      options.includePaths === undefined
        ? [defaultIncludePath]
        : options.includePaths.concat(defaultIncludePath);
    options.basePath = options.basePath || defaultBasePath;
  }

  try {
    const mFile = path.relative(process.cwd(), file);
    const ast = await compileSolFiles([mFile], options);
    await Promise.all(
      (
        await transform(ast, options)
      ).map(([fname, solidity]) =>
        outputResult(
          parse(fname).name,
          replaceSuffix(fname, '_warp.cairo'),
          solidity,
          options,
          ast,
        ),
      ),
    );
  } catch (e) {
    handleTranspilationError(e);
  }
}

program
  .command('analyse <file>')
  .description('Debug tool to analyse the AST')
  .option('--highlight <ids...>', 'Highlight selected ids in the AST')
  .action(analyseSol);

export interface IOptionalNetwork {
  network?: string;
}

export interface IOptionalFee {
  max_fee?: number;
}

program
  .command('status <tx_hash>')
  .description('Get the status of a transaction')
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .action(runStarknetStatus);

export interface IOptionalDebugInfo {
  debugInfo: boolean;
}

program
  .command('compile <file>')
  .description('Compile cairo files with warplib in the cairo-path')
  .option('-d, --debug-info', 'Include debug information', false)
  .action(async (file: string, options: IOptionalDebugInfo) => {
    await runStarknetCompile(file, options);
  });

export interface SolcInterfaceGenOptions {
  cairoPath: string;
  output?: string;
  solcVersion?: string;
  contractAddress?: string;
  classHash?: string;
}

program
  .command('gen-interface <file>')
  .description(
    'Use native Cairo contracts in your Solidity by creating a Solidity interface and a Cairo translation contract for the target Cairo contract',
  )
  .option('--cairo-path <cairo-path>', 'Cairo libraries/modules import path')
  .option(
    '--output <output>',
    'Output path for the Solidity interface and the Cairo translation contract',
  )
  .option(
    '--contract-address <contract-address>',
    'Address at which the target cairo contract has been deployed',
  )
  .option('--class-hash <class-hash>', 'Class hash of the cairo contract')
  .option('--solc-version <version>', 'Solc version to use', '0.8.14')
  .action(generateSolInterface);

interface IDeployProps_ {
  inputs?: string[];
  use_cairo_abi: boolean;
  no_wallet: boolean;
  wallet?: string;
}

export interface IGatewayProps {
  gateway_url?: string;
  feeder_gateway_url?: string;
}

export type IDeployProps = IDeployProps_ &
  IOptionalNetwork &
  IOptionalAccount &
  IOptionalDebugInfo &
  IGatewayProps &
  IOptionalFee;

program
  .command('deploy <file>')
  .description('Deploy a warped cairo contract')
  .option('-d, --debug_info', 'Compile include debug information', false)
  .option(
    '--inputs <inputs...>',
    'Arguments to be passed to constructor of the program as a comma separated list of strings, ints and lists',
    undefined,
  )
  .option('--use_cairo_abi', 'Use the cairo abi instead of solidity for the inputs', false)
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .option('--no_wallet', 'Do not use a wallet for deployment', false)
  .option('--wallet <wallet>', 'Wallet provider to use', process.env.STARKNET_WALLET)
  .option('--account <account>', 'Account to use for deployment', undefined)
  .option(
    '--account_dir <account_dir>',
    'The directory of the account.',
    process.env.STARKNET_ACCOUNT_DIR,
  )
  .option('--max_fee <max_fee>', 'Maximum fee to pay for the transaction.')
  .action(runStarknetDeploy);

interface IOptionalWallet {
  wallet?: string;
}

interface IOptionalAccount {
  account?: string;
  account_dir?: string;
}
export type IDeployAccountProps = IOptionalAccount &
  IOptionalNetwork &
  IOptionalWallet &
  IGatewayProps &
  IOptionalFee;

program
  .command('deploy_account')
  .description('Deploy an account to Starknet')
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used',
  )
  .option(
    '--account_dir <account_dir>',
    'The directory of the account.',
    process.env.STARKNET_ACCOUNT_DIR,
  )
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class',
    process.env.STARKNET_WALLET,
  )
  .option('--max_fee <max_fee>', 'Maximum fee to pay for the transaction.')
  .action(runStarknetDeployAccount);

interface ICallOrInvokeProps_ {
  address: string;
  function: string;
  inputs?: string[];
  use_cairo_abi: boolean;
}
export type ICallOrInvokeProps = ICallOrInvokeProps_ &
  IOptionalNetwork &
  IOptionalWallet &
  IOptionalAccount &
  IGatewayProps &
  IOptionalFee;

program
  .command('invoke <file>')
  .description('Invoke a function on a warped contract using the Solidity abi')
  .requiredOption('--address <address>', 'Address of contract to invoke')
  .requiredOption('--function <function>', 'Function to invoke')
  .option(
    '--inputs <inputs...>',
    'Input to function as a comma separated string, use square brackets to represent lists and structs. Numbers can be represented in decimal and hex.',
    undefined,
  )
  .option('--use_cairo_abi', 'Use the cairo abi instead of solidity for the inputs', false)
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used',
  )
  .option(
    '--account_dir <account_dir>',
    'The directory of the account',
    process.env.STARKNET_ACCOUNT_DIR,
  )
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class',
    process.env.STARKNET_WALLET,
  )
  .option('--max_fee <max_fee>', 'Maximum fee to pay for the transaction')
  .action(async (file: string, options: ICallOrInvokeProps) => {
    await runStarknetCallOrInvoke(file, false, options);
  });

program
  .command('call <file>')
  .description('Call a function on a warped contract using the Solidity abi')
  .requiredOption('--address <address>', 'Address of contract to call')
  .requiredOption('--function <function>', 'Function to call')
  .option(
    '--inputs <inputs...>',
    'Input to function as a comma separated string, use square brackets to represent lists and structs. Numbers can be represented in decimal and hex.',
    undefined,
  )
  .option('--use_cairo_abi', 'Use the cairo abi instead of solidity for the inputs', false)
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used',
  )
  .option(
    '--account_dir <account_dir>',
    'The directory of the account',
    process.env.STARKNET_ACCOUNT_DIR,
  )
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class',
    process.env.STARKNET_WALLET,
  )
  .option('--max_fee <max_fee>', 'Maximum fee to pay for the transaction')
  .action(async (file: string, options: ICallOrInvokeProps) => {
    await runStarknetCallOrInvoke(file, true, options);
  });

interface IOptionalVerbose {
  verbose: boolean;
}

interface IInstallOptions_ {
  python: string;
}

export type IInstallOptions = IInstallOptions_ & IOptionalVerbose;

program
  .command('install')
  .description('Install the python dependencies required for Warp')
  .option('--python <python>', 'Path to a python3.9 executable', 'python3.9')
  .option('-v, --verbose', 'Display python setup info')
  .action(runVenvSetup);

export interface IDeclareOptions {
  no_wallet: boolean;
  network?: string;
  wallet?: string;
  account?: string;
  account_dir?: string;
  gateway_url?: string;
  feeder_gateway_url?: string;
  max_fee?: string;
}

program
  .command('declare <cairo_contract>')
  .description('Declare a Cairo contract')
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used.',
  )
  .option(
    '--account_dir <account_dir>',
    'The directory of the account',
    process.env.STARKNET_ACCOUNT_DIR,
  )
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class',
    process.env.STARKNET_WALLET,
  )
  .option('--max_fee <max_fee>', 'Maximum fee to pay for the transaction')
  .action(runStarknetDeclare);

export type StarknetNewAccountOptions = IOptionalAccount &
  IOptionalAccount &
  IOptionalNetwork &
  IGatewayProps &
  IOptionalWallet;

program
  .command('new_account')
  .description('Command to create a new account')
  .option(
    '--account <account>',
    'The name of the account. If not given, account will be named "__default__". If it already exists, it will be overwritten.',
  )
  .option(
    '--account_dir <account_dir>',
    'The directory of the account',
    process.env.STARKNET_ACCOUNT_DIR,
  )
  .option('--network <network>', 'Starknet network URL', process.env.STARKNET_NETWORK)
  .option('--gateway_url <gateway_url>', 'Starknet gateway URL', process.env.STARKNET_GATEWAY_URL)
  .option(
    '--feeder_gateway_url <feeder_gateway_url>',
    'Starknet feeder gateway URL',
    process.env.STARKNET_FEEDER_GATEWAY_URL,
  )
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class',
    process.env.STARKNET_WALLET,
  )
  .action(runStarknetNewAccount);

const blue = chalk.bold.blue;
const green = chalk.bold.green;
program
  .command('version')
  .description('Warp version')
  .action(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pjson = require('../package.json');

    const execAsync = util.promisify(exec);
    const starknetVersion = (await execAsync('starknet --version')).stdout;

    console.log(blue(`Warp Version `) + green(pjson.version));
    console.log(blue(`Starknet Version `) + green(starknetVersion.split(' ')[1]));
  });
