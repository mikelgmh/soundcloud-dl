import { main } from './src/cli';

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
