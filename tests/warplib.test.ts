import { expect } from 'chai';
import { describe, it } from 'mocha';
import glob from 'glob';
import { cleanup, starknetCompile } from './util';

const paths = glob.sync('warplib/**/*.cairo');

describe('Warplib files should compile', function () {
  this.timeout(1800000);

  let compileResults: Array<{ success: boolean; result: { stdout: string; stderr: string } }>;

  before(async function () {
    compileResults = await Promise.all(
      paths.map(async (file) => {
        try {
          return { success: true, result: await starknetCompile(file, `${file}.json`) };
        } catch (err) {
          if (!!err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
            const errorData = err as { stdout: string; stderr: string };
            return {
              success: false,
              result: { stdout: errorData.stdout, stderr: errorData.stderr },
            };
          }

          throw err;
        }
      }),
    );
  });

  paths.forEach((path, i) => {
    it(path, async function () {
      try {
        const { success, result } = compileResults[i];
        expect(result, 'starknet-compile printed errors').to.include({ stderr: '' });
        expect(success).to.be.true;
      } catch (e) {
        expect(false, `${e}`).to.be.true;
      }
    });

    after(async function () {
      await cleanup(`${path}.json`);
    });
  });
});
