/**
 * 指针捕获的**唯一**入口：抓得到就抓，抓不到就算了。
 *
 * `Element.setPointerCapture()` 在「指针已经不活跃」时会抛 `NotFoundError`。踩到的情形
 * 不算罕见：合成事件（自动化脚本、冒烟测试、某些输入法/触控板驱动）、指针在两次事件
 * 之间被系统取消、以及在 `pointerdown` 里删掉了这个元素。
 *
 * 抓不到的后果只是「指针移出元素后不再收到事件」——而拖动本身照样能用，因为移动事件
 * 仍然冒泡到 `window`。但**让它抛出去就是一个未捕获异常**：控制台被污染，而且
 * 「渲染进程没有未捕获异常」这条底线会被打破（实测就是被冒烟测试抓到的）。
 *
 * 所以别在各处直接调 `setPointerCapture`，走这里。释放那边用 `hasPointerCapture`
 * 判断即可，不会抛。
 */
export function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* 抓不到不影响拖动：事件仍然会到达 window */
  }
}
