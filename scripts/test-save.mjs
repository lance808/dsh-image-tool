import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findSessionImage, saveImageAs } from '../lib/save.js';
import { apply } from '../lib/index.js';
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'image-save-'));
const ref = { attachmentId: 'test-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 };
const session = { header: { cwd }, deriveMessages: () => [{ content: [{ type: 'image', attachment: ref }] }] };
let reads = 0;
const readImage = async () => { reads++; return { ref, data: Buffer.from('png') }; };
try {
  assert.equal(findSessionImage(session), ref);
  assert.throws(() => findSessionImage(session, 'unknown'), /找不到/);
  const saved = await saveImageAs({ cwd, ref, targetPath: 'images/天空之城', readImage });
  assert.equal(saved.relativePath, './images/天空之城.png');
  assert.equal(await fs.readFile(saved.diskPath, 'utf8'), 'png');
  await assert.rejects(saveImageAs({ cwd, ref, targetPath: 'images/天空之城.png', readImage }), /已存在/);
  const before = reads;
  await assert.rejects(saveImageAs({ cwd, ref, targetPath: '../outside.png', readImage }), /工作目录内/);
  await assert.rejects(saveImageAs({ cwd, ref, targetPath: 'wrong.jpg', readImage }), /实际格式/);
  assert.equal(reads, before);
  const definitions = [];
  apply({
    tools: { register(def) { definitions.push(def); return () => {}; } },
    attachments: { readImage }, sessions: { get: () => session },
    settings: { describe: () => [] }, effect: fn => fn(),
  });
  const tool = definitions.find(def => def.name === 'save_generated_image');
  const result = await tool.execute({ path: '另存.png' }, { agent: { id: 'session' } });
  assert.equal(result.ok, true, result.note);
  assert.match(tool.output.render({}, result)[0].text, /已另存至 .*另存.png/);
  assert.equal((await tool.execute({ path: '另存.png' }, { agent: { id: 'session' } })).ok, false);
  console.log('PASS 另存：会话引用恢复、默认最近图片、路径显示、字节保存、拒绝覆盖、拒绝越界、扩展名验证、工具接线');
} finally { await fs.rm(cwd, { recursive: true, force: true }); }
