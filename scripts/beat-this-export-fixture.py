# 產生 tests/fixtures/beatThis/ 的參考資料（合成的 6 秒鼓聲，tests/beatThis.test.ts 用同一個公式重算波形）
# 用法：在有 beat_this 原始碼（src/beat_this）和 beat_this_small.onnx 的資料夾執行；輸出 fx_*.f32、fx_ref.json
import sys, torch, numpy as np, inspect, onnxruntime as ort, json
sys.path.insert(0, 'src/beat_this')
from beat_this.preprocessing import LogMelSpect
from beat_this.model.postprocessor import Postprocessor
sr = 22050; n = sr * 6
i = np.arange(n)
wav = (0.02 * np.sin(i * 0.0123) * np.sin(i * 0.731)).astype(np.float64)  # deterministic hum
for k in range(12):          # kick every 0.5 s starting 0.25 s -> 120 BPM
    s0 = int((0.25 + 0.5 * k) * sr); L = 2000; j = np.arange(L)
    amp = 0.9 if k % 4 == 0 else 0.5
    wav[s0:s0+L] += amp * np.sin(2*np.pi*(60 + 100*np.exp(-j/300))*j/sr) * np.exp(-j/600)
wav = wav.astype(np.float32)
mel = LogMelSpect()(torch.from_numpy(wav)).numpy().astype(np.float32)
pad = np.zeros((1,1500,128), np.float32); pad[0,:len(mel)] = mel
s = ort.InferenceSession('beat_this_small.onnx')
b, d = s.run(None, {'spect': pad})
L = len(mel)
mel.tofile('fx_mel.f32'); b[0,:L].astype(np.float32).tofile('fx_beat.f32'); d[0,:L].astype(np.float32).tofile('fx_down.f32')
pp = Postprocessor('minimal')
bt, db = pp(torch.from_numpy(b[0,:L]), torch.from_numpy(d[0,:L]))
print('frames', L, 'beats', np.round(bt,3).tolist(), 'down', np.round(db,3).tolist())
json.dump({'beats': [float(x) for x in bt], 'downbeats': [float(x) for x in db]}, open('fx_ref.json','w'))
