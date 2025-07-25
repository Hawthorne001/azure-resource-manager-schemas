// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { generateBasePaths, getPackageString, resolveAbsolutePath, validateAndReturnReadmePath } from '../specs';
import { SchemaConfiguration, generateSchemas, clearAutoGeneratedSchemaRefs, saveAutoGeneratedSchemaRefs } from '../generate';
import { findOrGenerateAutogenEntries } from '../autogenlist';
import colors from 'colors';
import { flatten } from 'lodash';
import { executeSynchronous, chunker, writeJsonFile } from '../utils';
import { Package } from '../models';
import yargs from 'yargs';
import path from 'path';

import { createWriteStream } from 'fs';
import stripAnsi from 'strip-ansi';
import { schemasBasePath } from '../constants';

const argsConfig = yargs(process.argv.slice(2))
  .strict()
  .option('specs-dir', { type: 'string', demandOption: true, desc: 'Path to the specs dir' })
  .option('batch-count', { type: 'number', desc: 'If running in batch mode, the total number of batch jobs running' })
  .option('batch-index', { type: 'number', desc: 'If running in batch mode, the index of this batch job' })
  .option('readme-files', { type: 'array', desc: 'The list of readme.md files to generate schemas for' })
  .option('output-path', { type: 'string', desc: 'The base path to save schema output' })
  .option('combine-batch-mode', { type: 'boolean', desc: 'If true, we rely on the combine-batches command to summarize the results.' })
  .option('summary-log-path', { type: 'string', desc: 'The path to store generation summary information. File will be saved in md format.' });

interface ILogger {
    out: (data: string) => void;
}

executeSynchronous(async () => {
    const args = await argsConfig.parseAsync();

    const specsPath = await resolveAbsolutePath(args['specs-dir']);
    let basePaths = await generateBasePaths(specsPath);

    let summaryPath = args['summary-log-path'];
    const combineBatchMode = args['combine-batch-mode'] ?? false;

    if (!summaryPath) {
        summaryPath = path.join(specsPath, 'summary.log');
        console.log(`Summary path not passed, using default value: ${summaryPath}`);
    }

    // resolve absolute path
    summaryPath = await resolveAbsolutePath(summaryPath);

    const batchIndex = args['batch-index'];
    const batchCount = args['batch-count'];
    if (batchCount !== undefined && batchIndex !== undefined) {
        basePaths = chunker(basePaths, batchCount)[batchIndex];

        console.log(`Generating following base paths for batch ${batchIndex}: ${JSON.stringify(basePaths, null, 2)}`);
    }

    const schemaConfigs: SchemaConfiguration[] = [];
    const packages: Package[] = [];

    const summaryLogger = await getLogger(summaryPath);

    for (const basePath of basePaths) {
        try {
            const readme = validateAndReturnReadmePath(specsPath, basePath);
            let filteredAutoGenList = (await findOrGenerateAutogenEntries(basePath, readme))
                .filter(x => x.disabledForAutogen !== true);

            if (args['readme-files']) {
                filteredAutoGenList = filteredAutoGenList.filter(c => {
                    const readmeFiles = args['readme-files']?.map(x => x.toString());
                    const r = readmeFiles?.find(f => f.startsWith('specification/' + c.basePath));
                    if (r) {
                        c.readmeFile = r;
                        return true;
                    }
                    return false;
                });
            }

            if (!combineBatchMode) {
                await clearAutoGeneratedSchemaRefs(filteredAutoGenList);
            }

            for (const autoGenConfig of filteredAutoGenList) {
                const pkg = {
                    path: ['schemas']
                } as Package;
                try {
                    const readme = validateAndReturnReadmePath(specsPath, autoGenConfig.readmeFile || autoGenConfig.basePath);
                    pkg.packageName = getPackageString(readme);

                    const startTime = Date.now();
                    const newConfigs = await generateSchemas(readme, autoGenConfig);
                    const generationTime = Date.now() - startTime;
                    console.log(`Time taken to generate ${colors.green.italic(autoGenConfig.basePath)} : ${colors.magenta.bold(generationTime.toString())} ms.`);
                    schemaConfigs.push(...newConfigs);
                    pkg.result = 'succeeded';
                    logOut(summaryLogger, 
                        `<details>
                        <summary>Successfully generated types for base path '${basePath}'.</summary>
                        </details>
                        `);
                } catch(error) {
                    pkg.packageName = autoGenConfig.basePath;
                    pkg.result = 'failed';
                    console.log(colors.red(`Caught exception processing autogenlist entry ${autoGenConfig.basePath}.`));
                    console.log(colors.red(`${(error as Error)?.stack || error}`));

                    // return a non-zero exit code to mark the process as failed
                    process.exitCode = 1;
                    // Use markdown formatting as this summary will be included in the PR description
                    logOut(summaryLogger, 
                        `<details>
                        <summary>Failed to generate types for base path '${autoGenConfig.basePath}' and namespace '${autoGenConfig.namespace}'</summary>
                        \`\`\`
                        ${error}
                        \`\`\`
                        </details>
                        `);
                }
                packages.push(pkg);
            }
        } catch (error) {
            // return a non-zero exit code to mark the process as failed
            process.exitCode = 1;
            // Use markdown formatting as this summary will be included in the PR description
            // This error usually indicates that a file has not been found (readme)
            logOut(summaryLogger, 
                `<details>
                <summary>Failed to generate types for base path '${basePath}' probably due to readme not found or due to any other file not found exception.</summary>
                \`\`\`
                ${error}
                \`\`\`
                </details>
                `);
        }
        
    }

    if (combineBatchMode) {
        const schemaConfigFile = path.join(schemasBasePath, 'schemaconfig.json');
        await writeJsonFile(schemaConfigFile, schemaConfigs);
    } else {
        await saveAutoGeneratedSchemaRefs(flatten(schemaConfigs), true);
    }

    if (args['output-path']) {
        const outputPath = await resolveAbsolutePath(args['output-path']);
        await writeJsonFile(outputPath, { packages });
    }
});

function logOut(logger: ILogger, line: string) {
    logger.out(`${line}\n`);
}
  
async function getLogger(logFilePath: string): Promise<ILogger> {
    const logFileStream = createWriteStream(logFilePath, { flags: 'a' });

    return {
        out: (data: string) => {
            process.stdout.write(data);
            logFileStream.write(stripAnsi(data));
        }
    };
}
