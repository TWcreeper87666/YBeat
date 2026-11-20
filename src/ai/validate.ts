/**
 * AI 寫的模組先在本機驗證，跟真正套用時用同一套包裝：
 * GLSL → 用一個隱藏的 WebGL2 編譯（buildEffectFS / buildTransitionFS）；變速 → new Function 後實際呼叫一次。
 */
import type { ModuleKind } from '../store';
import { parseParams, resolveParams } from '../engine/params';
import { VS, buildEffectFS, buildTransitionFS } from '../engine/renderer';
import { ease } from '../engine/remap';

export { codeBlocks, detectKind, guessName, type CodeBlock } from './text';

let gl: WebGL2RenderingContext | null | undefined;
let vs: WebGLShader | null = null;
function ctx() {
  if (gl === undefined) {
    gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, VS);
      gl.compileShader(vs);
    }
  }
  return gl;
}

function compileGlsl(fsSrc: string): string | null {
  const g = ctx();
  if (!g || !vs) return null; // 沒有 WebGL2：沒辦法檢查，當作通過（套用時渲染器會再報錯）
  const fs = g.createShader(g.FRAGMENT_SHADER)!;
  g.shaderSource(fs, fsSrc);
  g.compileShader(fs);
  if (!g.getShaderParameter(fs, g.COMPILE_STATUS)) {
    const log = g.getShaderInfoLog(fs) ?? 'compile failed';
    g.deleteShader(fs);
    return log.trim();
  }
  const p = g.createProgram()!;
  g.attachShader(p, vs);
  g.attachShader(p, fs);
  g.linkProgram(p);
  const ok = g.getProgramParameter(p, g.LINK_STATUS);
  const log = ok ? null : (g.getProgramInfoLog(p) ?? 'link failed').trim();
  g.deleteProgram(p);
  g.deleteShader(fs);
  return log;
}

/** 檢查模組能不能用；回傳錯誤訊息，沒問題 = null */
export function validateModule(kind: ModuleKind, code: string): string | null {
  const defs = parseParams(code);
  if (kind === 'remap') {
    let fn: unknown;
    try {
      fn = new Function('ease', `"use strict";\n${code}\n;return typeof remap === 'function' ? remap : null;`)(ease);
    } catch (e) {
      return String(e);
    }
    if (typeof fn !== 'function') return 'function remap(t, p, info) not found';
    const p = resolveParams(defs, undefined);
    for (const t of [0, 0.5, 1.9]) {
      try {
        const v = (fn as (t: number, p: unknown, i: unknown) => number)(t, p, { dur: 2, srcDur: 10, in: 0 });
        if (typeof v !== 'number' || !Number.isFinite(v)) return `remap(${t}, …) returned ${String(v)} (must be a finite number of seconds)`;
      } catch (e) {
        return `remap(${t}, …) threw: ${String(e)}`;
      }
    }
    return null;
  }
  const fn = kind === 'transition' ? 'transition' : 'effect';
  if (!new RegExp(`\\bvec4\\s+${fn}\\s*\\(\\s*vec2`).test(code)) return `missing: vec4 ${fn}(vec2 uv)`;
  return compileGlsl(kind === 'transition' ? buildTransitionFS(code, defs) : buildEffectFS(code, defs));
}
