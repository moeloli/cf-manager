/**
 * 将日期格式化为中国标准时间（UTC+8）的字符串。
 * 统一使用 Asia/Shanghai 时区，避免因浏览器/服务器时区不同导致显示偏差。
 */
export function formatCN(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
