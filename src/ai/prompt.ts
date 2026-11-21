/**
 * 給 AI 的系統提示：模組格式說明（跟渲染器實際的包裝一致）、內建範例、使用教學。
 * 內容固定不變（方便模型端快取）；目前的模組程式碼放在使用者訊息裡。
 */
import { lang } from '../i18n';
import { GLSL_LIB } from '../engine/renderer';
import { BUILTIN_MODULES } from '../modules/builtin';
import { SHORTCUTS, TUTORIAL } from '../ui/helpText';

const LANG_NAME: Record<string, string> = { zh: 'Traditional Chinese (Taiwan)', en: 'English', ja: 'Japanese' };

/** 當範例的內建模組（短、各有代表性） */
const EXAMPLES = ['fx-rgb', 'fx-shake', 'fx-zoompulse', 'tr-iris', 'tr-scaleout', 'remap-boomerang'];

const SPEC = `
## Module format

YBeat effects, transitions and speed remaps are small code modules. The app wraps them automatically.

### Parameters (all kinds)
Declare tweakable parameters with comment lines; the UI builds sliders from them and the app declares the GLSL uniforms for you (never declare them yourself):
  // @param NAME: TYPE = DEFAULT (MIN..MAX) "Label"
TYPE is float | int | bool | color | point | curve. Range and label are optional.
- color: vec3 in GLSL; default is a hex like #ff3d6e.
- point: vec2 in GLSL, already in uv space (use it directly, e.g. zoomUV(uv, z, center)); default is "x,y" in screen space 0..1 with y DOWN, e.g. 0.5,0.5. The user drags it on the preview. Use it for any center / focus / origin.
- curve: vec4 cubic-bezier in GLSL; evaluate with curve(NAME, x) (x 0..1 → eased value). Default is a preset (linear, inOut, inOut3, in, out, expoOut, expoIn, back) or "x1,y1,x2,y2". The user edits it in a curve editor. Use it instead of hard-coded easeXxx() for the main motion, e.g. float p = curve(ease, progress);
- A float can add @box(POINT) after the label, e.g. // @param to: float = 0.2 (0..1) "End size" @box(center). The preview then draws the whole frame scaled by that value around that point (zoomUV(uv, value, point)) and the user drags its corners. Use it for scale / size amounts that scale about the point.
Effects may also set a default clip length:  // @duration 0.5

### Effect (GLSL ES 3.00, fragment only)
Write exactly:  vec4 effect(vec2 uv) { ... }
- tex(uv) samples the layer below (uv 0..1, origin bottom-left).
- Do NOT write #version, precision, main(), in/out, or uniform declarations — they already exist.

### Transition (GLSL ES 3.00)
Write exactly:  vec4 transition(vec2 uv) { ... }
- getFrom(uv) = outgoing clip, getTo(uv) = incoming clip, progress = 0→1 over the transition.

### Built-in uniforms (GLSL)
u_resolution (vec2, px), u_time (project seconds), u_local (seconds since the item started), u_duration (seconds), u_progress (0→1 over the item), u_level (current audio loudness 0..1), u_beat (1.0 on a beat, then decays).

### Built-in GLSL helpers (already defined, do not redefine)
${GLSL_LIB.trim()}

### GLSL rules
GLSL ES 3.00: float literals need a dot (1.0 not 1), no implicit int→float, use texture() only through tex/getFrom/getTo, no texture2D, loops need constant bounds.

### Speed remap (JavaScript)
Write exactly:  function remap(t, p, info) { ... }
- t = seconds since the clip started (already multiplied by the clip's overall rate).
- p = parameter values by name (p.speed …).
- info = { dur: clip length in seconds, srcDur: source media length, in: clip in-point }.
- Return the source time in seconds, relative to the clip's in-point (return t = normal playback). The app clamps it to the media.
- \`ease\` is available: ease.linear, inCubic, outCubic, inOutCubic, inExpo, outExpo, outBack, inOutBack (x 0..1), ease.clamp(x, a=0, b=1).
`;

function examples(): string {
  return EXAMPLES.map((id) => BUILTIN_MODULES.find((m) => m.id === id))
    .filter(Boolean)
    .map((m) => `### ${m!.kind}: ${m!.name}\n\`\`\`${m!.kind === 'remap' ? 'js' : 'glsl'}\n${m!.code.trim()}\n\`\`\``)
    .join('\n\n');
}

const OUTPUT_RULES = `
## When you write a module
- Put the complete module in ONE fenced block: \`\`\`glsl for effects/transitions, \`\`\`js for remaps.
- First line: a comment with a short name, then a colon and one-line description, e.g. // Neon Edge: glowing outline
- Expose the interesting numbers as @param so the user can tune them; use point for centers and curve for the main easing.
- The app compiles your code. If it reports an error, reply with the full corrected module in one block.
`;

function langLine() {
  return `Reply in ${LANG_NAME[lang] ?? 'the user\'s language'} unless the user writes in another language. Code comments may stay in that language too.`;
}

let chatCache: { lang: string; text: string } | null = null;
/** 聊天：回答怎麼用、也會寫模組 */
export function chatSystem(): string {
  if (chatCache?.lang === lang) return chatCache.text;
  const tut = TUTORIAL.map((s) => `### ${s.title}\n${s.items.map((i) => `- ${i}`).join('\n')}`).join('\n\n');
  const keys = SHORTCUTS.map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const text = `You are the assistant built into YBeat, a browser-based short-video editor (timeline, keyframes, masks, beat-synced audio, MP4 export). Effects, transitions and speed remaps are user-editable code modules.
Answer questions about using the app based on the guide below; if the guide does not cover something, say you are not sure instead of inventing features. Keep answers short and practical.
${langLine()}

# User guide
${tut}

# Keyboard shortcuts
${keys}

# Writing modules
${SPEC}
${OUTPUT_RULES}
## Examples (built-in modules)
${examples()}
`;
  chatCache = { lang, text };
  return text;
}

/** 改 / 寫一個模組：只要格式說明，不需要使用教學（省額度） */
export function moduleSystem(): string {
  return `You write and edit code modules for YBeat, a browser video editor.
${langLine()}
Reply with the complete module in one fenced code block, followed by at most two short sentences about what changed. No other text.
${SPEC}
${OUTPUT_RULES}
## Examples (built-in modules)
${examples()}
`;
}
