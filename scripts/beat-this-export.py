# Beat This! small0 → public/models/beat_this_small0.onnx + beat_this_mel.bin
#
# 需要：torch、torchaudio、onnx、onnxruntime、einops、rotary-embedding-torch，
# 以及 CPJKU/beat_this 原始碼（pip download "beat_this @ git+https://github.com/CPJKU/beat_this.git" 解開）
# 和 small0.ckpt（https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/small0.ckpt）。
# 用法：python scripts/beat-this-export.py <beat_this 原始碼資料夾> <small0.ckpt> <輸出資料夾>
#
# 注意：export 完之後同一個 process 裡的 PyTorch 模型結果會跑掉，要比對請重新載入模型（下面就是這樣做）。
import inspect, sys
import numpy as np, onnxruntime as ort, torch

src, ckpt_path, out = sys.argv[1:4]
sys.path.insert(0, src)
from beat_this.model.beat_tracker import BeatThis
from beat_this.preprocessing import LogMelSpect
from beat_this.utils import replace_state_dict_key


def load():
    ck = torch.load(ckpt_path, map_location='cpu', weights_only=True)
    hp = {k: v for k, v in ck['hyper_parameters'].items() if k in set(inspect.signature(BeatThis).parameters)}
    m = BeatThis(**hp)
    m.load_state_dict(replace_state_dict_key(ck['state_dict'], 'model.', ''))
    return m.eval()


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        o = self.m(x)
        return o['beat'], o['downbeat']


# 靜態 [1, 1500, 128]：前端一律補滿 1500 格
torch.onnx.export(Wrap(load()), (torch.randn(1, 1500, 128),), f'{out}/beat_this_small0.onnx',
                  input_names=['spect'], output_names=['beat', 'downbeat'], opset_version=17)
LogMelSpect().spect_class.mel_scale.fb.numpy().astype(np.float32).tofile(f'{out}/beat_this_mel.bin')

x = np.random.default_rng(0).standard_normal((1, 1500, 128)).astype(np.float32)
with torch.no_grad():
    ref = load()(torch.from_numpy(x))['beat'].numpy()
got = ort.InferenceSession(f'{out}/beat_this_small0.onnx').run(None, {'spect': x})[0]
print('max |onnx - torch|', np.abs(got - ref).max())
