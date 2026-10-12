// 服务端图片自动缩图：工作区目录里超过单图上限的照片不再拒绝分析，而是
// 就地降采样重编码到上限以内，原图保持不动。解码依赖 Electron 主进程的
// nativeImage（桌面端把 server 跑在主进程里）；纯 Node（测试、裸服务端）
// 取不到时返回 null，由调用方给出可行动的错误。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 宽度按系数递减、质量固定 85——OCR 读单据文字足够，不追求观感；保底
// 480px，再小文字已不可读，宁可失败也不交低质量结果。
const SCALES = [0.7, 0.5, 0.35, 0.2];
const MIN_WIDTH = 480;

function nativeResizer() {
  try {
    const nativeImage = require("electron")?.nativeImage;
    if (typeof nativeImage?.createFromBuffer !== "function") return null;
    return {
      decode: (data) => {
        const image = nativeImage.createFromBuffer(data);
        return image.isEmpty() ? null : image;
      },
      encode: (image, width) => image.resize({ width }).toJPEG(85),
    };
  } catch {
    return null;
  }
}

// 把超过 maxBytes 的图片压到上限内，返回 JPEG 字节；解不开（非 PNG/JPEG）
// 或最低档仍超限时返回 null。resizer 参数仅供测试注入。
export function shrinkImage(data, maxBytes, resizer = nativeResizer()) {
  if (!resizer) return null;
  const image = resizer.decode(data);
  if (!image) return null;
  const width = image.getSize?.().width || 0;
  if (!width) return null;
  for (const scale of SCALES) {
    let jpeg;
    try {
      jpeg = resizer.encode(image, Math.max(MIN_WIDTH, Math.round(width * scale)));
    } catch {
      return null;
    }
    if (jpeg.length <= maxBytes) return jpeg;
  }
  return null;
}
