const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const template = path.join(root, 'tools', 'backend-config.template.json');
const config = JSON.parse(fs.readFileSync(template, 'utf8'));
assert.strictEqual(config.video_output.hwaccel, 'none');
assert.strictEqual(config.video_output.video_codec, 'libx264');
assert.strictEqual(config.ai_search.profiles[0].api_key_env, 'DEEPSEEK_API_KEY');
assert(!JSON.stringify(config).includes('"api_key":'));

// Invoke only the actual config loader against the shipped template. No video,
// user config, FFmpeg process or model weights are read.
const backend = process.env.EAGLE_BACKEND_ROOT || 'D:/Auto-scenes-extraction-1.3.0/Auto-scenes-extraction-1.3.0';
const result = execFileSync(path.join(backend, 'python', 'python.exe'), [
  '-c',
  'import sys; from A_coreUtils.video_processing.ffmpeg_precision_cutter import FFmpegPrecisionCutter; c=FFmpegPrecisionCutter.__new__(FFmpegPrecisionCutter)._load_config(sys.argv[1]); assert c["video_output"]["video_codec"] == "libx264"; print("template accepted")',
  template,
], { cwd: backend, encoding: 'utf8' });
assert(result.includes('template accepted'));
console.log('Backend distribution template has no secret and is accepted by the real cutter config loader');
