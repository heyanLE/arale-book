/** Card faces contain learning material; workflow warnings belong to the review UI. */
const CAUTION = /(?:仅供参考|仅(?:作为|为).{0,6}参考|(?:译文|OCR|内容|词义).{0,12}未经.{0,8}校对|(?:无法|不能|不)保证.{0,12}(?:准确|正确)|(?:请|建议|需要|需).{0,8}人工.{0,8}(?:核对|确认|校对)|JLPT.{0,10}非官方|(?:尚未|未经|未由|未做).{0,12}(?:语境|消歧|核对本句|校对)|(?:AI|自动).{0,6}生成.{0,10}(?:参考|校对|核对)|可能存在.{0,8}(?:错误|误差)|请自行核实|请以.{0,12}为准)/u;
export function learningCardText(value: string): string {
  return value
    .replace(/[（(【\[]([^（）()【】\[\]]*)[）)】\]]/gu, (whole, inside: string) => CAUTION.test(inside) || /^(?:AI 自动生成|词典参考|待人工核对|未经人工校对)$/.test(inside.trim()) ? '' : whole)
    .split(/\n|(?<=[。；;])/u)
    .filter(part => !CAUTION.test(part))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function learningEtymology(value: string): string {
  return /(?:可能(?:来自|源于|来源)|或许|疑似|推测|词源不明|不确定)/u.test(value) ? '' : learningCardText(value);
}
