import { $t } from '../i18n';
import { makeClip, uid, useStore, type Clip, type FxItem, type Media } from '../store';
import { addMediaBlob } from './media';
import { newKey } from './keyframes';

const PALETTES = [
  ['#ff2e63', '#252a34'],
  ['#08d9d6', '#3a0ca3'],
  ['#f9ed69', '#f08a5d'],
  ['#b83b5e', '#6a2c70'],
  ['#00f5d4', '#f15bb5'],
  ['#fee440', '#00bbf9'],
];

function makeCard(i: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 1920;
  const g = c.getContext('2d')!;
  const [a, b] = PALETTES[i % PALETTES.length];
  const grad = g.createLinearGradient(0, 0, 1080, 1920);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1080, 1920);
  g.globalAlpha = 0.12;
  g.fillStyle = '#fff';
  for (let k = -20; k < 40; k++) {
    g.beginPath();
    g.moveTo(k * 90, 0);
    g.lineTo(k * 90 + 40, 0);
    g.lineTo(k * 90 + 40 - 1100, 1920);
    g.lineTo(k * 90 - 1100, 1920);
    g.fill();
  }
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 18;
  g.beginPath();
  g.arc(540, 960, 380, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 420px system-ui, sans-serif';
  g.fillText(String(i + 1).padStart(2, '0'), 540, 980);
  g.font = '800 72px system-ui, sans-serif';
  g.fillText('B E A T S Y N C', 540, 1560);
  return new Promise((res) => c.toBlob((blob) => res(blob!), 'image/png'));
}

export async function loadDemo() {
  const media: Media[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await addMediaBlob(await makeCard(i), $t('示範卡 {0}.png', i + 1));
    if (m) media.push(m);
  }
  const trs = [null, 'tr-crashzoom', 'tr-whip', 'tr-spin', 'tr-diagonal', 'tr-iris'];
  const clips: Clip[] = media.map((m, i) =>
    makeClip({
      mediaId: m.id,
      start: i,
      duration: 1,
      transitionIn: trs[i] ? { moduleId: trs[i]!, params: {}, duration: 0.4 } : null,
      // 最後一張示範「動態縮放」：從放大旋轉回到正常
      ...(i === 5
        ? { keys: { scale: [newKey(0, 1.4, [0.34, 1.56, 0.64, 1]), newKey(1, 1)], rotation: [newKey(0, -8, [0.34, 1.56, 0.64, 1]), newKey(1, 0)] } }
        : {}),
    }),
  );
  // 上層軌：子母畫面示範
  clips.push(makeClip({ mediaId: media[0].id, track: 1, start: 2, duration: 2, fit: 'contain', transform: { x: 0.22, y: -0.3, scale: 0.35, rotation: 6, opacity: 1 } }));
  const effects: FxItem[] = [
    { id: uid(), moduleId: 'fx-entrance', params: {}, start: 0, duration: 0.6, track: 1 },
    { id: uid(), moduleId: 'fx-speedlines', params: {}, start: 2.35, duration: 0.6, track: 0 },
  ];
  for (let k = 1; k < 6; k++) {
    effects.push({ id: uid(), moduleId: 'fx-shake', params: {}, start: k, duration: 0.3, track: 0 });
    effects.push({ id: uid(), moduleId: k % 2 ? 'fx-flash' : 'fx-rgb', params: {}, start: k, duration: 0.3, track: 1 });
  }
  useStore.setState(() => ({
    clips,
    effects,
    audios: [],
    selection: null,
    selected: [],
    time: 0,
    loop: null,
    playing: true,
  }));
}
