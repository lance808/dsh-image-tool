// 改图输入解析（lib/image-source.js）的离线测试。
//
// 这个模块是插件的**唯一一处"读用户的盘"**，所以它的边界就是插件的攻击面：
// 路径穿越、符号链接逃逸、把非图片当图片、把别人的附件当成自己的。
// 下面每一条都对应一种真实的误用方式，而不是为了覆盖率凑数。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findSessionImageByRef,
  looksLikeAttachmentId,
  readWorkspaceImage,
  resolveEditImage,
  resolveEditMask,
  sessionImages,
} from '../lib/image-source.js';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}

/** 真实编码的 1×1 PNG（不是随机字节：魔数嗅探与平台附件校验都认它）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF_1X1 = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20)]);

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-image-source-'));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-image-outside-'));

async function cleanup() {
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
}

/** 造一个假会话：deriveMessages() 返回给定的消息数组。 */
function fakeSession(messages) {
  return { deriveMessages: () => messages };
}

const REF_A = { attachmentId: 'sha256:aaa', mediaType: 'image/png', bytes: PNG_1X1.byteLength, width: 1, height: 1, name: 'a.png' };
const REF_B = { attachmentId: 'sha256:bbb', mediaType: 'image/png', bytes: PNG_1X1.byteLength, width: 1, height: 1, name: 'b.png' };

await test('读工作目录内的图片：媒体类型按魔数判定，不信任扩展名', async () => {
  const file = path.join(workspace, 'pretend.txt');
  await fs.writeFile(file, PNG_1X1);
  const image = await readWorkspaceImage({ cwd: workspace, reference: 'pretend.txt' });
  assert.equal(image.mediaType, 'image/png', '扩展名是 .txt 也必须按真实字节判为 PNG');
  assert.equal(image.buffer.byteLength, PNG_1X1.byteLength);
  assert.equal(image.name, 'pretend.txt');
});

await test('读工作目录内的图片：绝对路径也在允许范围内', async () => {
  const file = path.join(workspace, 'absolute.png');
  await fs.writeFile(file, PNG_1X1);
  const image = await readWorkspaceImage({ cwd: workspace, reference: file });
  assert.equal(image.mediaType, 'image/png');
});

await test('拒绝工作目录之外的路径：相对路径的 .. 逃逸', async () => {
  await assert.rejects(
    () => readWorkspaceImage({ cwd: workspace, reference: '../outside.png' }),
    /工作目录内/,
    '词法上越界必须立刻拒绝，而不是先读再看',
  );
});

await test('拒绝工作目录之外的绝对路径', async () => {
  const stranger = path.join(outside, 'stranger.png');
  await fs.writeFile(stranger, PNG_1X1);
  await assert.rejects(
    () => readWorkspaceImage({ cwd: workspace, reference: stranger }),
    /工作目录内/,
  );
});

await test('拒绝经由符号链接/junction 指向工作目录之外的路径（realpath 二次确认）', async () => {
  const link = path.join(workspace, 'escape');
  let created = false;
  try {
    // Windows 上目录符号链接需要开发者模式或管理员权限；建不了就说明这个环境测不了，
    // 而不是把"没测到"当成"通过"——这里显式说出跳过原因。
    await fs.symlink(outside, link, 'junction');
    created = true;
  } catch (error) {
    console.log(`  （跳过：本环境无法创建符号链接：${error.code}）`);
  }
  if (!created) return;
  const target = path.join(link, 'stranger.png');
  await fs.writeFile(path.join(outside, 'stranger.png'), PNG_1X1).catch(() => {});
  await assert.rejects(
    () => readWorkspaceImage({ cwd: workspace, reference: target }),
    /符号链接|工作目录内/,
    '词法检查挡不住 junction：必须 realpath 之后再判一次',
  );
});

await test('拒绝空文件，并报出是哪一个', async () => {
  await fs.writeFile(path.join(workspace, 'empty.png'), Buffer.alloc(0));
  await assert.rejects(
    () => readWorkspaceImage({ cwd: workspace, reference: 'empty.png' }),
    /空文件/,
  );
});

await test('超过字节上限的图片被拒绝（先看大小，不读进内存）', async () => {
  const big = path.join(workspace, 'big.png');
  await fs.writeFile(big, Buffer.concat([PNG_1X1, Buffer.alloc(4096)]));
  await assert.rejects(
    () => readWorkspaceImage({ cwd: workspace, reference: 'big.png', maxImageBytes: 100 }),
    /超过上限/,
  );
});

await test('没有会话工作目录时不猜路径，直接报错', async () => {
  await assert.rejects(() => readWorkspaceImage({ cwd: null, reference: 'a.png' }), /工作目录/);
});

await test('sessionImages：按"最近优先"收集，并穿透 tool-result 的嵌套 content', () => {
  const session = fakeSession([
    { role: 'user', content: [{ type: 'image', attachment: REF_B }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x' }, { type: 'image', attachment: REF_A }] }],
    },
  ]);
  const refs = sessionImages(session);
  assert.deepEqual(refs.map((ref) => ref.attachmentId), ['sha256:aaa', 'sha256:bbb'], '倒序即最近优先；嵌套的 image 块不能漏');
  assert.equal(findSessionImageByRef(session, 'sha256:bbb').name, 'b.png');
  assert.equal(findSessionImageByRef(session, 'sha256:zzz'), undefined, '不存在的 id 不能瞎返回一个');
  assert.deepEqual(sessionImages({}), [], '没有 deriveMessages 时返回空数组，而不是抛错');
});

await test('looksLikeAttachmentId：能区分附件 id 与文件路径', () => {
  assert.equal(looksLikeAttachmentId('sha256:abc123'), true);
  assert.equal(looksLikeAttachmentId('att-1234567890abcdef'), true);
  assert.equal(looksLikeAttachmentId('generated-images/a.png'), false, '带斜杠的是路径');
  assert.equal(looksLikeAttachmentId('D:\\pics\\a.png'), false, '带盘符的是路径');
  // 下面这几条是真实踩到的坑：宽松正则会把短文件名当成附件 id，
  // 于是"读这个文件"变成"去会话里找一个叫 input.png 的附件"，报出完全对不上的错误。
  assert.equal(looksLikeAttachmentId('input.png'), false, '带图片扩展名的一律按路径处理');
  assert.equal(looksLikeAttachmentId('reference.JPEG'), false, '扩展名判定不分大小写');
  assert.equal(looksLikeAttachmentId('a.png'), false);
  assert.equal(looksLikeAttachmentId('temp-1'), false, '太短的不可能是平台附件 id');
  assert.equal(looksLikeAttachmentId(''), false);
});

await test('resolveEditImage：省略 image 时取会话最近一张（连续改图的基础）', async () => {
  const session = fakeSession([{ role: 'user', content: [{ type: 'image', attachment: REF_B }] }]);
  const resolved = await resolveEditImage({
    reference: '',
    session,
    cwd: workspace,
    readImage: async (ref) => ({ ref, data: PNG_1X1 }),
  });
  assert.equal(resolved.image.mediaType, 'image/png');
  assert.match(resolved.origin, /最近一张图片 sha256:bbb/, '用了哪张图必须如实回报，用户才有得核对');
});

await test('resolveEditImage：会话里没有图片时给出可执行的替代方案', async () => {
  await assert.rejects(
    () => resolveEditImage({ reference: '', session: fakeSession([]), cwd: workspace, readImage: async () => ({ data: PNG_1X1 }) }),
    /没有可用的图片/,
  );
});

await test('resolveEditImage：attachmentId 只认本会话里真实存在的引用', async () => {
  const session = fakeSession([{ role: 'user', content: [{ type: 'image', attachment: REF_A }] }]);
  const read = [];
  const resolved = await resolveEditImage({
    reference: 'sha256:aaa',
    session,
    cwd: workspace,
    readImage: async (ref) => { read.push(ref); return { ref, data: PNG_1X1 }; },
  });
  assert.equal(read[0].attachmentId, 'sha256:aaa', '读到附件服务的是**完整引用**，不是裸 id');
  assert.match(resolved.origin, /会话附件/);

  await assert.rejects(
    () => resolveEditImage({ reference: 'sha256:nope', session, cwd: workspace, readImage: async () => ({ data: PNG_1X1 }) }),
    /找不到附件/,
  );
});

await test('resolveEditImage：路径写法读工作目录文件，并把来源讲清楚', async () => {
  await fs.writeFile(path.join(workspace, 'input.png'), PNG_1X1);
  const resolved = await resolveEditImage({ reference: 'input.png', session: fakeSession([]), cwd: workspace, readImage: async () => ({ data: PNG_1X1 }) });
  assert.match(resolved.origin, /工作目录文件 input\.png/);
});

await test('resolveEditMask：非 PNG 的遮罩放行但明确提示', async () => {
  await fs.writeFile(path.join(workspace, 'mask.gif'), GIF_1X1);
  const resolved = await resolveEditMask({ reference: 'mask.gif', session: fakeSession([]), cwd: workspace });
  assert.equal(resolved.mask.mediaType, 'image/gif');
  assert.match(resolved.warning, /PNG/, 'OpenAI 约定 mask 必须是 PNG，这里要如实提醒而不是默默发出去');

  await fs.writeFile(path.join(workspace, 'mask.png'), PNG_1X1);
  const ok = await resolveEditMask({ reference: 'mask.png', session: fakeSession([]), cwd: workspace });
  assert.equal(ok.warning, null, 'PNG 遮罩不该有警告');

  const none = await resolveEditMask({ reference: '', session: fakeSession([]), cwd: workspace });
  assert.equal(none.mask, null, '不给 mask 就是整图编辑，不是错误');
});

await cleanup();
console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
