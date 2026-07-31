import { execSync } from 'node:child_process';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://modaco:modaco@localhost:5432/modaco_test?schema=public';
process.env.CACHE_DRIVER = 'memory';

execSync('npx prisma db push --skip-generate --accept-data-loss', {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  stdio: 'inherit',
});
