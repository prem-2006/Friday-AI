// Friday: runs one web research request through the same Parallel search
// OpenDots gives Friday, and prints the sources it would cite. Parallel's
// anonymous tier is free for light use; this spends no Gnani or Evon credits.
//
// From the repo root:
//   node --env-file-if-exists=.env --import tsx friday/scripts/test-research.ts "dentist Indiranagar open evening"
import { parallelSources } from '../../src/server/parallel.js';

const objective =
  process.argv.slice(2).join(' ').trim() ||
  'Dentists near Indiranagar, Bengaluru that are open in the evening';

const warnings: string[] = [];
const started = Date.now();
const sources = await parallelSources(
  {
    objective,
    searchQueries: [objective.slice(0, 200)],
    onWarning: (message) => warnings.push(message),
  },
  {
    webSearchProvider: 'parallel',
    parallelApiKey: process.env.PARALLEL_API_KEY,
  },
  AbortSignal.timeout(60_000),
);
console.log(
  `${sources.length} sources in ${Math.round((Date.now() - started) / 1000)} s for: ${objective}\n`,
);
for (const source of sources)
  console.log(
    `- ${source.title}\n  ${source.url}\n  ${source.text.replace(/\s+/g, ' ').slice(0, 160)}…\n`,
  );
if (warnings.length) console.log(`Warnings: ${warnings.join(' ')}`);
if (!sources.length) process.exitCode = 1;
