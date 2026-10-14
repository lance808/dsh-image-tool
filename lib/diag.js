// 轻量诊断日志。
//
// 为什么写系统临时目录而不是按相对层级往上爬：插件常以 `link:` 方式装进 profile，
// 往上是 <DSH_HOME>/.. ——那会在用户主目录旁凭空造出目录，只在作者机器上"看起来正常"。
// 可用环境变量覆盖（空字符串 = 关闭）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 每次调用现算，方便测试里改环境变量。 */
export function diagLogPath(plugin = 'dsh-image-tool') {
  const env = process.env.DSH_IMAGE_TOOL_DIAG;
  if (env === '') return null;
  if (typeof env === 'string' && env.trim() !== '') return env;
  return path.join(os.tmpdir(), `${plugin}.log`);
}

export function createDiag(plugin = 'dsh-image-tool') {
  return function diag(message) {
    const file = diagLogPath(plugin);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // 诊断日志失败绝不能影响生图本身。
    }
  };
}
