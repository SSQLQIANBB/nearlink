/**
 * 会议列表分页参数解析（HTTP 边界）。
 *
 * 在边界转换数字字符串并校验范围；非法参数返回 null（路由层映射为 400），
 * 不静默回到第一页。
 */
export interface PageParams {
  page: number;
  pageSize: number;
}

export function parsePageParams(query: Record<string, unknown>): PageParams | null {
  const pageRaw = query.page;
  const pageSizeRaw = query.pageSize;
  const page = pageRaw === undefined ? 1 : Number(pageRaw);
  const pageSize = pageSizeRaw === undefined ? 20 : Number(pageSizeRaw);
  if (
    Number.isNaN(page) ||
    Number.isNaN(pageSize) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    return null;
  }
  return { page, pageSize };
}
