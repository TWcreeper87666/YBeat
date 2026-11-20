import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // onnxruntime-web 自己載入 .wasm，預先打包會弄壞路徑
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
});
