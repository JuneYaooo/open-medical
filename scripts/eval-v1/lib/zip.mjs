// 极简 ZIP 读写(评测侧独立验收用,不依赖任何第三方包)。
// 仅支持 xlsx/docx 所需子集:store(0) 与 deflate(8)、UTF-8 文件名、单磁盘。
// 读取方要防伪造扩展名:必须先通过 ZIP 结构校验,再谈内容。
import { inflateRawSync, deflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

/** 解析 ZIP:返回 Map<name, Buffer>。结构非法(伪造扩展名冒充)抛错。 */
export function readZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22)
    throw new Error("不是有效的 ZIP 文件(长度不足)");
  // 从尾部找 EOCD,注释区最长 65535。
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (bytes.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件(缺少中央目录)");
  const count = bytes.readUInt16LE(eocd + 10);
  let ptr = bytes.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(ptr) !== CEN) throw new Error("ZIP 中央目录损坏");
    const method = bytes.readUInt16LE(ptr + 10);
    const compSize = bytes.readUInt32LE(ptr + 20);
    const nameLen = bytes.readUInt16LE(ptr + 28);
    const extraLen = bytes.readUInt16LE(ptr + 30);
    const commentLen = bytes.readUInt16LE(ptr + 32);
    const localOff = bytes.readUInt32LE(ptr + 42);
    const name = bytes.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    // 本地段:定位数据起点。
    if (bytes.readUInt32LE(localOff) !== LOC) throw new Error(`ZIP 本地段损坏:${name}`);
    const lNameLen = bytes.readUInt16LE(localOff + 26);
    const lExtraLen = bytes.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}:${name}`);
    files.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  if (!files.size) throw new Error("ZIP 内没有任何条目");
  return files;
}

/** 生成 ZIP(store/deflate 自动选择)。entries: [ [name, Buffer|string] ] */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const stored = deflateRawSync(data, { level: 9 });
    const useDeflate = stored.length < data.length;
    const payload = useDeflate ? stored : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(LOC),
      u16(20),
      u16(0x0800), // UTF-8 名称
      u16(method),
      u16(0),
      u16(0x21), // 日期 1980-01-01 修正 DOS 时间(评测夹具固定值即可)
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      payload,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(CEN),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(method),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(payload.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocdBuf = Buffer.concat([
    u32(EOCD),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, eocdBuf]);
}
