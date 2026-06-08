// 区域截图框选的纯几何计算:client 坐标 ↔ 渲染像素 ↔ 自然像素。
// 与 ScreenshotCropOverlay 组件分离,便于单测且不触发 react-refresh 警告。

export interface Point {
  x: number;
  y: number;
}

/** 渲染后图片在视口中的位置与尺寸(client 坐标系,getBoundingClientRect 取得)。 */
export interface ImageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 自然像素坐标系下的裁剪矩形,直接喂给 canvas drawImage 的源参数。 */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 渲染坐标系(相对图片左上角)的框选框,用于画选区与读尺寸。 */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 把鼠标拖拽的两端点(client 坐标)换算成「相对图片左上角」的框选框,并夹取到图片边界内。
 * 渲染选区与读取尺寸都用它——纯函数,无 DOM 读取。
 */
export function normalizeDisplayRect(start: Point, end: Point, imgBox: ImageBox): DisplayRect {
  const x1 = clamp(start.x - imgBox.left, 0, imgBox.width);
  const y1 = clamp(start.y - imgBox.top, 0, imgBox.height);
  const x2 = clamp(end.x - imgBox.left, 0, imgBox.width);
  const y2 = clamp(end.y - imgBox.top, 0, imgBox.height);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/**
 * 把框选框从「渲染像素」映射回「自然像素」,得到 canvas 裁剪源矩形。
 * 缩放系数 = 自然尺寸 / 渲染尺寸(object-contain 下等比,xy 各算一份更稳)。
 * 结果四舍五入并夹到图片尺寸内,避免 drawImage 越界。
 */
export function computeCropRect(
  start: Point,
  end: Point,
  imgBox: ImageBox,
  naturalWidth: number,
  naturalHeight: number,
): CropRect {
  if (imgBox.width <= 0 || imgBox.height <= 0) {
    return { sx: 0, sy: 0, sw: 0, sh: 0 };
  }
  const scaleX = naturalWidth / imgBox.width;
  const scaleY = naturalHeight / imgBox.height;
  const rect = normalizeDisplayRect(start, end, imgBox);
  const sx = clamp(Math.round(rect.left * scaleX), 0, naturalWidth);
  const sy = clamp(Math.round(rect.top * scaleY), 0, naturalHeight);
  const sw = clamp(Math.round(rect.width * scaleX), 0, naturalWidth - sx);
  const sh = clamp(Math.round(rect.height * scaleY), 0, naturalHeight - sy);
  return { sx, sy, sw, sh };
}
