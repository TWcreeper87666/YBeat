/** 錄製分頁：主執行緒（tabRecord.ts）和 Worker（tabRecordWorker.ts）共用的常數與訊息 */
export const FPS = 30;
/** 每幾格一個關鍵格（選範圍裁切時從前一個關鍵格開始解） */
export const KEY_EVERY = FPS;

export type RecIn =
  | { type: 'start'; video: ReadableStream<VideoFrame>; w: number; h: number; cfg: VideoEncoderConfig }
  /**
   * 一段聲音（主執行緒讀的：聲音串流傳進 Worker 會失敗，只有影像可以）。
   * ts = 時間戳（µs）、at = 收到時的絕對時間（performance.timeOrigin + now，µs；Worker 用同一種時鐘）
   */
  | { type: 'audio'; ts: number; at: number; rate: number; ch: Float32Array[] }
  | { type: 'stop' };
export interface RecChunk { data: ArrayBuffer; key: boolean; timestamp: number; duration: number }
export type RecOut =
  | { type: 'started' }
  | { type: 'done'; w: number; h: number; chunks: RecChunk[]; decoderConfig: VideoDecoderConfig | null; audio: { rate: number; ch: Float32Array[] } | null; duration: number }
  | { type: 'error'; err: string };

