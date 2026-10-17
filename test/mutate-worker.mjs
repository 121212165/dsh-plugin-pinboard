// Child-process worker for the concurrency test: one pin_add per process,
// mutate-then-readback, exit 1 if the marker did not survive.
import { PinStore, addPin } from '../src/plugin.ts';

const [, , dataPath, marker] = process.argv;
const store = new PinStore(dataPath);
store.mutate((items) => {
  const result = addPin(items, marker, 'agent');
  return result.kind === 'added' ? result.items : items;
});
if (!store.load().some((pin) => pin.text === marker)) {
  console.error(`readback failed for ${marker}`);
  process.exit(1);
}
