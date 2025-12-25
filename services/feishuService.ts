/**
 * 前端仅通过后端 /api 中转访问飞书：
 * - 解决浏览器 CORS
 * - 不暴露 APP_SECRET / Token
 */
export class FeishuService {
  static async fetchTableRecords<T>(tableId: string): Promise<T[]> {
    try {
      const url = `/api/feishu/records?tableId=${encodeURIComponent(tableId)}`;

      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backend error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as any;

      // 约定：后端返回 { items: [...] }
      const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
        ? data
        : [];

      return items as T[];
    } catch (error) {
      console.error("FeishuService.fetchTableRecords failed:", error);
      // 兜底：返回空数组（页面会自动进入“演示模式”提示）
      return [];
    }
  }

  /**
   * 拉取飞书字段元信息（用于自动表头/调试字段名）
   */
  static async fetchTableFields(tableId: string) {
    const url = `/api/feishu/fields?tableId=${encodeURIComponent(tableId)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
}
