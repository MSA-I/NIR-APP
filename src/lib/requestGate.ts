export function createRequestGate() {
  let current = 0;
  let mounted = false;
  return {
    mount: () => { mounted = true; },
    unmount: () => { mounted = false; current += 1; },
    begin: () => ++current,
    invalidate: () => { current += 1; },
    isCurrent: (request: number) => mounted && request === current,
  };
}
