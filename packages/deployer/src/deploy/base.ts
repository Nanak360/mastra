import { MastraBase } from '@mastra/core/base';
import { Mastra } from '@mastra/core/mastra';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path, { join } from 'path';
import { fileURLToPath } from 'url';

import { bundle } from '../build/bundle.js';
import { Deps } from '../build/deps.js';
import { upsertMastraDir } from '../build/utils.js';

export class Deployer extends MastraBase {
  deps: Deps = new Deps();
  dotMastraPath: string;
  projectPath: string;
  override name: string = '';
  type: 'Deploy' | 'Dev';

  constructor({ dir, type }: { dir: string; type: 'Deploy' | 'Dev' }) {
    super({ component: 'DEPLOYER', name: `Mastra ${type}` });
    this.projectPath = dir;
    this.dotMastraPath = join(dir, '.mastra');
    this.type = type;
    this.deps.__setLogger(this.logger);
  }

  getMastraPath() {
    return this.dotMastraPath;
  }

  async getMastra() {
    return (await import(join(this.dotMastraPath, 'mastra.mjs'))) as { mastra: Mastra };
  }

  async writePackageJson() {
    this.logger.debug(`[Mastra ${this.type}] - Writing package.json`);
    let projectPkg: any = {
      dependencies: {},
    };

    try {
      projectPkg = JSON.parse(readFileSync(join(this.dotMastraPath, '..', 'package.json'), 'utf-8'));
    } catch (_e) {
      // no-op
    }

    const mastraDeps = Object.entries(projectPkg.dependencies)
      .filter(([name]) => name.startsWith('@mastra'))
      .reduce((acc: any, [name, version]) => {
        if (version === 'workspace:*') {
          acc[name] = 'latest';
        } else {
          acc[name] = version;
        }

        return acc;
      }, {});

    const pkgPath = join(this.dotMastraPath, 'package.json');

    if (this.type === 'Dev' && existsSync(pkgPath)) {
      return;
    }

    mastraDeps['@mastra/loggers'] = 'latest';

    writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: 'server',
          version: '1.0.0',
          description: '',
          type: 'module',
          main: 'index.mjs',
          scripts: {
            start: 'node ./index.mjs',
          },
          author: '',
          license: 'ISC',
          dependencies: {
            ...mastraDeps,
            hono: '4.6.17',
            '@hono/node-server': '^1.13.7',
            superjson: '^2.2.2',
            'zod-to-json-schema': '^3.24.1',
          },
        },
        null,
        2,
      ),
    );
  }

  async install(): Promise<void> {
    this.logger.info(`[Mastra ${this.type}] - Ensuring your dependencies up to date...`);
    await this.deps.install({ dir: this.projectPath });
  }

  protected getEnvFiles(): string[] {
    const envFiles = ['.env', '.env.development', '.env.local']
      .map(file => join(this.projectPath, file))
      .filter(file => existsSync(file));
    return envFiles;
  }

  getEnvVars() {
    // Get all env vars
    const envFiles = this.getEnvFiles();
    const envVars: Record<string, string> = {};

    for (const file of envFiles) {
      const vars = this.parseEnvFile(file);
      for (const envVar of vars) {
        const [key, value] = envVar.split('=');
        if (key && value) {
          envVars[key] = value;
        }
      }
    }

    return envVars;
  }

  protected parseEnvFile(filePath: string): string[] {
    const content = readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => line.includes('=')); // Only include valid KEY=value pairs
  }

  async build({ dir, useBanner = true }: { dir: string; useBanner?: boolean }) {
    if (!existsSync(this.dotMastraPath)) {
      mkdirSync(this.dotMastraPath);
    }

    await bundle(dir, { useBanner, outfile: join(this.dotMastraPath, 'mastra.mjs') });
  }

  async buildServer(
    { playground = false, swaggerUI = false }: { playground?: boolean; swaggerUI?: boolean } = {
      playground: false,
      swaggerUI: false,
    },
  ) {
    upsertMastraDir({ dir: this.projectPath });

    const templatePath = join(this.dotMastraPath, 'hono.mjs');

    writeFileSync(
      templatePath,
      `
      import { createHonoServer } from './server.mjs';
      import { mastra } from './mastra.mjs';

      export const app = await createHonoServer(mastra, { playground: ${playground}, swaggerUI: ${swaggerUI} });
    `,
    );
  }

  async writeServerFile() {
    const fileServerPath = await import.meta.resolve('@mastra/deployer/server');
    const serverPath = fileURLToPath(fileServerPath);
    copyFileSync(serverPath, join(this.dotMastraPath, 'server.mjs'));
  }

  async prepare({
    dir,
    playground,
    useBanner = true,
    swaggerUI,
  }: {
    useBanner?: boolean;
    dir?: string;
    playground?: boolean;
    swaggerUI?: boolean;
  }) {
    this.logger.info('Preparing .mastra directory');
    upsertMastraDir({ dir: this.projectPath });
    const dirPath = dir || path.join(this.projectPath, 'src/mastra');
    this.writePackageJson();
    this.writeServerFile();
    try {
      await this.install();
    } catch (error) {
      this.logger.error('Failed to install dependencies', { error });
    }

    try {
      await this.build({ dir: dirPath, useBanner });
    } catch (error) {
      this.logger.error('Failed to build', { error });
    }

    try {
      await this.buildServer({ playground, swaggerUI });
    } catch (error) {
      this.logger.error('Failed to build server', { error });
    }
  }
}
