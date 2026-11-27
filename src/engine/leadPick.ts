import type { Media } from '../store';
import type { AeLead } from './autoEditSettings';
import type { FaceBox } from './mediaAnalysis';
import { sampleMedia } from './mediaSampler';
import { decodeAt } from './matteDecode';

type Box = [number, number, number, number];
type EmbeddedFace = FaceBox & { emb: number[] };

const embedded = (face: FaceBox & { emb?: number[] }): face is EmbeddedFace => !!face.emb?.length;

/** 框與臉都是素材座標的中心點和寬高；至少框住一部分臉才算選中。 */
function overlap(box: Box, face: FaceBox): number {
  const fw = face.w ?? face.h;
  const x = Math.max(0, Math.min(box[0] + box[2] / 2, face.x + fw / 2) - Math.max(box[0] - box[2] / 2, face.x - fw / 2));
  const y = Math.max(0, Math.min(box[1] + box[3] / 2, face.y + face.h / 2) - Math.max(box[1] - box[3] / 2, face.y - face.h / 2));
  return x * y / Math.max(1e-9, fw * face.h);
}

async function faceThumb(media: Media, t: number, face: FaceBox): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return media.thumb;
  const draw = (src: CanvasImageSource, w: number, h: number) => {
    const side = Math.max((face.w ?? face.h) * w, face.h * h) * 1.35;
    const sx = Math.max(0, Math.min(w - side, face.x * w - side / 2));
    const sy = Math.max(0, Math.min(h - side, face.y * h - side / 2));
    ctx.drawImage(src, sx, sy, Math.min(side, w), Math.min(side, h), 0, 0, 64, 64);
  };
  try {
    if (media.kind === 'image') {
      const img = new Image();
      img.src = media.url;
      await img.decode();
      draw(img, img.naturalWidth, img.naturalHeight);
    } else {
      let got = false;
      await decodeAt({ url: media.url, times: [t], tol: 0.05, alive: () => true, onFrame: (_k, frame) => {
        draw(frame, frame.displayWidth, frame.displayHeight);
        got = true;
        frame.close();
      } });
      if (!got) return media.thumb;
    }
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return media.thumb;
  }
}

/** 預覽框對到最近的分析影格，再挑框住最多的臉。 */
export async function leadFromBox(media: Media, t: number, box: Box): Promise<AeLead | null> {
  if (media.kind !== 'video' && media.kind !== 'image') return null;
  const sampled = await sampleMedia(media);
  const frames = media.kind === 'image'
    ? [{ time: 0, faces: sampled.faceList }]
    : (sampled.info?.facesAt ?? []).map((faces, i) => ({ time: i * sampled.info!.step, faces }))
      .filter((frame) => Math.abs(frame.time - t) <= 1.5)
      .sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t));
  for (const frame of frames) {
    const best = (frame.faces ?? []).filter(embedded)
      .map((face) => ({ face, score: overlap(box, face) }))
      .filter((x) => x.score >= 0.2)
      .sort((a, b) => b.score - a.score)[0];
    if (best) return { emb: best.face.emb, thumb: await faceThumb(media, frame.time, best.face) };
  }
  return null;
}
