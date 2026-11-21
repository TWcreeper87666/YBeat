/** 色板素材用的純色圖（9:16 小圖，渲染時會依 fit 拉滿） */
export async function colorBlob(hex: string): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = 108;
  c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = hex;
  g.fillRect(0, 0, c.width, c.height);
  return new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
}

