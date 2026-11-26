import { useStore } from '../src/store';
import { markerSnapPoints } from '../src/engine/snap';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const s = useStore.getState();
s.clearMarkers();
const later = s.addMarker(5);
const first = s.addMarker(-2, '起點');
const middle = s.addMarker(2);
ok(useStore.getState().markers.map((m) => m.t).join() === '0,2,5', 'markers stay sorted and negative time clamps to zero');
ok(useStore.getState().markers.find((m) => m.id === middle)?.name === '標記 3', 'default name uses marker count');
s.updateMarker(later, { t: 1, name: '修改', color: '#ff0000' });
ok(useStore.getState().markers.map((m) => m.id).join() === [first, later, middle].join(), 'moving a marker re-sorts the list');
ok(useStore.getState().markers.find((m) => m.id === later)?.name === '修改', 'rename updates marker');
ok(markerSnapPoints(useStore.getState().markers).join() === '0,1,2', 'snap targets include marker times');
ok(markerSnapPoints(useStore.getState().markers, later).join() === '0,2', 'dragged marker is excluded from snap targets');
s.updateMarker(later, { t: -10 });
ok(useStore.getState().markers.find((m) => m.id === later)?.t === 0, 'updated time clamps to zero');
s.removeMarker(first);
ok(!useStore.getState().markers.some((m) => m.id === first), 'remove deletes the selected marker');
s.clearMarkers();
ok(useStore.getState().markers.length === 0, 'clear removes all markers');

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
