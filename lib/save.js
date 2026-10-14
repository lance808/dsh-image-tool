import fs from 'node:fs/promises';
import path from 'node:path';
import { extensionFor } from './generate.js';

export function relativeImagePath(cwd, file) {
  const relative = path.relative(cwd, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return file;
  return './' + relative.split(path.sep).join('/');
}

/** 从当前会话的图片块恢复引用，重启后也可另存。 */
export function findSessionImage(session, attachmentId) {
  const messages = session?.deriveMessages?.() ?? [];
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m]?.content ?? [];
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block.type === 'image' && block.attachment
        && (!attachmentId || block.attachment.attachmentId === attachmentId)) return block.attachment;
    }
  }
  throw new Error('当前会话中找不到该图片；请提供本会话图片的 attachmentId，或先生成图片。');
}

/** 只允许会话目录内部写入，拒绝符号链接目录与覆盖，不改变图片编码。 */
export async function saveImageAs({ cwd, ref, targetPath, readImage, signal }) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('未取得会话工作目录，无法另存。');
  const extension = '.' + extensionFor(ref.mediaType);
  let requested = String(targetPath ?? '').trim();
  if (!requested) throw new Error('另存路径不能为空。');
  if (!path.extname(requested)) requested += extension;
  const actualExt = path.extname(requested).toLowerCase();
  if (actualExt !== extension && !(extension === '.jpg' && actualExt === '.jpeg')) {
    throw new Error(`图片实际格式为 ${ref.mediaType}，请使用 ${extension} 扩展名；另存不进行格式转换。`);
  }
  const file = path.resolve(cwd, requested);
  const relative = path.relative(cwd, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('另存路径必须位于当前会话工作目录内。');
  }
  const root = await fs.realpath(cwd);
  let dir = root;
  const parts = relative.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    signal?.throwIfAborted();
    dir = path.join(dir, part);
    try { await fs.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('另存路径包含符号链接或非目录，已拒绝。');
  }
  const stored = await readImage(ref, signal);
  signal?.throwIfAborted();
  try {
    await fs.writeFile(path.join(dir, parts.at(-1)), stored.data, { flag: 'wx', signal });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('目标文件已存在，请选择其他名称；不会覆盖原文件。');
    throw error;
  }
  return { diskPath: file, relativePath: relativeImagePath(cwd, file), bytes: stored.data.byteLength };
}
