// The repository runs each .test.ts file directly after bundling it with esbuild.
// Keep this small synchronous interface so the cases work with that runner.
export function describe(_name: string, fn: () => void) { fn(); }

type Case = ((name: string, fn: () => void) => void) & { skip: (name: string, fn: () => void) => void };
export const it: Case = Object.assign(
  (name: string, fn: () => void) => {
    fn();
    console.log(`PASS ${name}`);
  },
  { skip: (name: string, _fn: () => void) => console.log(`SKIP ${name}`) },
);
