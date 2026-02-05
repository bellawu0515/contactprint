// src/utils/feishuColumns.ts
import type { Column } from "../components/DataTable";

export type FeishuFieldMeta = {
  field_name: string;
  field_type?: number;
  [k: string]: any;
};

/** 将飞书记录扁平化成普通对象：{ _record_id, ...fields } */
export function flattenFeishuRecord(record: any): Record<string, any> {
  return {
    _record_id: record?.record_id,
    ...(record?.fields || {}),
  };
}

const normalize = (s: string) => (s ?? "").trim().toLowerCase();

function bestMatchFieldName(allFieldNames: string[], key: string): string | undefined {
  const k = normalize(key);
  if (!k) return undefined;

  // 1) exact match
  const exact = allFieldNames.find((n) => normalize(n) === k);
  if (exact) return exact;

  // 2) field contains key
  const contains = allFieldNames.find((n) => normalize(n).includes(k));
  if (contains) return contains;

  // 3) key contains field
  const reverseContains = allFieldNames.find((n) => k.includes(normalize(n)));
  if (reverseContains) return reverseContains;

  return undefined;
}

/** 返回字段顺序：优先字段（模糊匹配） + 其余字段 */
export function orderFieldNames(allFieldNames: string[], priorityKeys: string[]): string[] {
  const used = new Set<string>();
  const ordered: string[] = [];

  for (const key of priorityKeys) {
    const hit = bestMatchFieldName(allFieldNames, key);
    if (hit && !used.has(hit)) {
      used.add(hit);
      ordered.push(hit);
    }
  }

  for (const name of allFieldNames) {
    if (!used.has(name)) {
      used.add(name);
      ordered.push(name);
    }
  }

  return ordered;
}

// ==============================
// 企业级自动列规则（你要的“省事版”）
// ==============================

/** 识别数值类字段：自动右对齐 + 2位小数显示（由 DataTable 负责格式化） */
const isNumberLikeField = (name: string) => {
  const n = normalize(name);
  return (
    n.includes("库存") ||
    n.includes("重量") ||
    n.includes("长") ||
    n.includes("宽") ||
    n.includes("高") ||
    n.includes("尺寸") ||
    n.includes("cm") ||
    n.includes("mm") ||
    n.includes("kg") ||
    n.includes("lb") ||
    n.includes("费用") ||
    n.includes("单价") ||
    n.includes("金额") ||
    n.includes("体积") ||
    n.includes("cbm") ||
    n.includes("比例") ||
    n.includes("率") ||
    n.includes("天数")
  );
};

/** 识别需要换行的字段：备注/材料/说明/描述等 */
const isWrapField = (name: string) => {
  return (
    name.includes("备注") ||
    name.includes("材料") ||
    name.includes("说明") ||
    name.includes("描述") ||
    name.includes("要求") ||
    name.includes("问题") ||
    name.includes("原因")
  );
};

/**
 * ✅ 第5步就在这里改：
 * 固定关键列（左侧冻结）：图 + SKU/物料编号 + 品名
 */
const isKeyStickyField = (name: string) => {
  return (
    name === "图" ||
    name.includes("SKU") ||
    name.includes("物料") ||
    name.includes("品名")
  );
};

/** 识别图片/附件字段（名称或 field_type） */
const isImageFieldByMeta = (meta?: FeishuFieldMeta) => {
  const name = meta?.field_name || "";
  const n = normalize(name);

  // 名称命中
  const nameHit =
    name === "图" ||
    n.includes("图片") ||
    n.includes("image") ||
    n.includes("photo") ||
    n.includes("附件") ||
    n.includes("图纸");

  // field_type 命中（不同版本可能不同，这里做容错）
  // 飞书多维表常见：附件/图片字段会是某个固定 type（不依赖它也能跑）
  const typeHit = typeof meta?.field_type === "number" && [17, 18, 20].includes(meta.field_type);

  return nameHit || typeHit;
};

/** 将飞书附件字段 value 转成 {url,name} 供 DataTable image 渲染 */
function extractImage(value: any): { url?: string; name?: string } | null {
  // 1) 直接就是字符串 url
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("http")) return { url: s, name: "image" };
    return null;
  }

  // 2) 常见：数组附件 [{tmp_url,url,name,...}]
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (first && typeof first === "object") {
      const url = first.tmp_url || first.url || first.link;
      const name = first.name || first.file_name || "image";
      if (url) return { url, name };
    }
    return null;
  }

  // 3) 单个对象 {tmp_url,url,name}
  if (value && typeof value === "object") {
    const url = (value as any).tmp_url || (value as any).url || (value as any).link;
    const name = (value as any).name || (value as any).file_name || "image";
    if (url) return { url, name };
  }

  return null;
}

/**
 * 生成自动列（企业版）：
 * - 先按 priorityKeys 模糊匹配排序
 * - 再把剩余字段追加
 * - 关键列 sticky left
 * - 数值列右对齐
 * - 图片列 type=image + 预览
 */
export function buildAutoColumns(params: {
  fieldMetas: FeishuFieldMeta[];
  priorityKeys?: string[];
  includeRecordId?: boolean;
  maxColumns?: number;
}): Column<Record<string, any>>[] {
  const {
    fieldMetas,
    priorityKeys = [],
    includeRecordId = false,
    maxColumns = 60,
  } = params;

  const allNames = (fieldMetas || [])
    .map((f) => f?.field_name)
    .filter(Boolean) as string[];

  const orderedNames = orderFieldNames(allNames, priorityKeys).slice(0, maxColumns);

  const cols: Column<Record<string, any>>[] = [];

  if (includeRecordId) {
    cols.push({
      header: "record_id",
      width: 220,
      minWidth: 220,
      sticky: "left",
      accessor: (row) => row?._record_id ?? "",
    } as any);
  }

  for (const name of orderedNames) {
    const meta = (fieldMetas || []).find((m) => m?.field_name === name);
    const isImage = isImageFieldByMeta(meta);

    // 列宽策略（企业后台常用：关键列宽一点、数字窄一点、图片固定）
    const width =
      isImage ? 260 :
      isKeyStickyField(name) ? 220 :
      isNumberLikeField(name) ? 140 : 180;

    const minWidth =
      isImage ? 260 :
      isKeyStickyField(name) ? 200 : 140;

    cols.push({
      header: name,
      width,
      minWidth,
      sticky: isKeyStickyField(name) ? "left" : undefined,
      align: isNumberLikeField(name) ? "right" : "left",
      wrap: isWrapField(name),
      type: isImage ? "image" : isNumberLikeField(name) ? "number" : "auto",
      accessor: (row) => {
        const v = row?.[name];
        if (isImage) return extractImage(v);
        return v;
      },
    } as any);
  }

  return cols;
}
