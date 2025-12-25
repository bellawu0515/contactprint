import React, { useMemo, useState } from "react";

export type ColumnAlign = "left" | "center" | "right";
export type ColumnType = "text" | "number" | "image" | "auto";

export type Column<T> = {
  header: string;
  accessor: keyof T | ((item: T) => React.ReactNode);

  // 企业级增强
  width?: number | string;       // 例如 120 / "12rem"
  minWidth?: number | string;
  align?: ColumnAlign;           // 默认 left
  wrap?: boolean;                // 默认 false（不换行）
  type?: ColumnType;             // 默认 auto
  sticky?: "left" | "right";     // 固定列
  className?: string;
};

type DataTableProps<T> = {
  data: T[];
  columns: Column<T>[];
  isLoading?: boolean;

  // 企业级增强
  height?: number | string;      // 表格可滚动高度，例如 620 或 "70vh"
  rowHeight?: "compact" | "normal";
  zebra?: boolean;               // 斑马纹
};

function safeJson(v: any): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return String(v);
  }
}

function toDisplayText(value: any): string {
  if (value === null || value === undefined) return "";

  const t = typeof value;

  if (t === "string") {
    const s = value.trim();
    // 数字字符串且有小数点 -> 2位小数
    if (/^-?\d+(\.\d+)?$/.test(s) && s.includes(".")) {
      const n = Number(s);
      if (Number.isFinite(n)) return n.toFixed(2);
    }
    return value;
  }

  if (t === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  if (t === "boolean") return String(value);

  // Array
  if (Array.isArray(value)) {
    if (value.length === 0) return "";

    // 原始值数组
    if (value.every((x) => ["string", "number", "boolean"].includes(typeof x))) {
      return value.map(String).join(", ");
    }

    // 富文本 [{text}]
    if (value.every((x) => x && typeof x === "object" && "text" in x)) {
      return value.map((x: any) => String(x.text ?? "")).join("");
    }

    // 附件 [{name}]
    if (value.every((x) => x && typeof x === "object" && "name" in x)) {
      return value.map((x: any) => String(x.name ?? "")).join(", ");
    }

    return safeJson(value);
  }

  if (t === "object") {
    if ("text" in value) return String((value as any).text ?? "");
    if ("name" in value) return String((value as any).name ?? "");
    return safeJson(value);
  }

  return String(value);
}

function alignClass(align?: ColumnAlign) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function widthStyle(col: Column<any>) {
  const style: React.CSSProperties = {};
  if (col.width !== undefined) style.width = col.width as any;
  if (col.minWidth !== undefined) style.minWidth = col.minWidth as any;
  return style;
}

export default function DataTable<T extends Record<string, any>>({
  data,
  columns,
  isLoading,
  height = 620,
  rowHeight = "normal",
  zebra = true,
}: DataTableProps<T>) {
  const [previewImg, setPreviewImg] = useState<string | null>(null);

  const rowPad = rowHeight === "compact" ? "py-2" : "py-3";

  // 预计算 sticky 左列偏移（只支持 sticky left，足够企业常用）
  const stickyLeftOffsets = useMemo(() => {
    let acc = 0;
    return columns.map((c) => {
      if (c.sticky === "left") {
        const cur = acc;
        // 需要固定列宽才稳定，没写宽度也能用但会有抖动
        const w =
          typeof c.width === "number"
            ? c.width
            : typeof c.width === "string" && c.width.endsWith("px")
              ? Number(c.width.replace("px", ""))
              : 0;
        acc += w || 0;
        return cur;
      }
      return 0;
    });
  }, [columns]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* 滚动容器：横向 + 纵向 */}
      <div
        className="overflow-auto"
        style={{ height: typeof height === "number" ? `${height}px` : height }}
      >
        <table className="min-w-full text-left border-separate border-spacing-0">
          {/* 表头 sticky */}
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              {columns.map((col, idx) => {
                const isStickyLeft = col.sticky === "left";
                const stickyStyle: React.CSSProperties = isStickyLeft
                  ? { position: "sticky", left: stickyLeftOffsets[idx], zIndex: 20 }
                  : {};

                return (
                  <th
                    key={idx}
                    style={{ ...widthStyle(col), ...stickyStyle }}
                    className={[
                      "px-4 py-3 text-xs font-bold uppercase tracking-wider",
                      "bg-slate-50 border-b border-slate-200",
                      "text-slate-500 whitespace-nowrap",
                      alignClass(col.align),
                      isStickyLeft ? "shadow-[2px_0_0_0_rgba(226,232,240,1)]" : "",
                    ].join(" ")}
                  >
                    {col.header}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100">
            {isLoading ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center text-slate-400">
                  Loading...
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center text-slate-400">
                  No data
                </td>
              </tr>
            ) : (
              data.map((item, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={[
                    zebra && rowIndex % 2 === 1 ? "bg-slate-50/60" : "bg-white",
                    "hover:bg-indigo-50/60 transition-colors",
                  ].join(" ")}
                >
                  {columns.map((col, colIndex) => {
                    const raw =
                      typeof col.accessor === "function"
                        ? col.accessor(item)
                        : (item as any)[col.accessor as any];

                    const isStickyLeft = col.sticky === "left";
                    const stickyStyle: React.CSSProperties = isStickyLeft
                      ? { position: "sticky", left: stickyLeftOffsets[colIndex], zIndex: 10 }
                      : {};

                    // 如果 accessor 返回 ReactElement，直接渲染
                    if (React.isValidElement(raw)) {
                      return (
                        <td
                          key={colIndex}
                          style={{ ...widthStyle(col), ...stickyStyle }}
                          className={[
                            "px-4",
                            rowPad,
                            "text-sm text-slate-700",
                            col.wrap ? "whitespace-normal break-words" : "whitespace-nowrap",
                            alignClass(col.align),
                            isStickyLeft ? "bg-inherit shadow-[2px_0_0_0_rgba(226,232,240,1)]" : "",
                            col.className ?? "",
                          ].join(" ")}
                        >
                          {raw}
                        </td>
                      );
                    }

                    // image type：如果 raw 是 {url,name} 或 string url，做预览
                    const type = col.type ?? "auto";
                    if (type === "image") {
                      const url =
                        typeof raw === "string"
                          ? raw
                          : raw && typeof raw === "object"
                            ? raw.url || raw.tmp_url
                            : null;

                      const name =
                        raw && typeof raw === "object" ? raw.name : undefined;

                      return (
                        <td
                          key={colIndex}
                          style={{ ...widthStyle(col), ...stickyStyle }}
                          className={[
                            "px-4",
                            rowPad,
                            "text-sm text-slate-700",
                            "whitespace-nowrap",
                            alignClass(col.align),
                            isStickyLeft ? "bg-inherit shadow-[2px_0_0_0_rgba(226,232,240,1)]" : "",
                            col.className ?? "",
                          ].join(" ")}
                        >
                          {url ? (
                            <button
                              className="inline-flex items-center gap-2"
                              onMouseEnter={() => setPreviewImg(url)}
                              onMouseLeave={() => setPreviewImg(null)}
                              onClick={() => window.open(url, "_blank")}
                              title={name || "image"}
                            >
                              <img
                                src={url}
                                alt={name || "image"}
                                className="h-10 w-10 object-cover rounded-lg border border-slate-200"
                                loading="lazy"
                              />
                              <span className="text-xs text-slate-500 truncate max-w-[160px]">
                                {name || "image"}
                              </span>
                            </button>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      );
                    }

                    const text = toDisplayText(raw);

                    return (
                      <td
                        key={colIndex}
                        style={{ ...widthStyle(col), ...stickyStyle }}
                        className={[
                          "px-4",
                          rowPad,
                          "text-sm text-slate-700",
                          col.wrap ? "whitespace-normal break-words" : "whitespace-nowrap",
                          alignClass(col.align),
                          isStickyLeft ? "bg-inherit shadow-[2px_0_0_0_rgba(226,232,240,1)]" : "",
                          col.className ?? "",
                        ].join(" ")}
                        title={text}
                      >
                        {text || <span className="text-slate-300">-</span>}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 图片悬浮预览（右下角浮层） */}
      {previewImg && (
        <div className="pointer-events-none fixed bottom-6 right-6 z-[999] bg-white border border-slate-200 shadow-xl rounded-2xl p-2">
          <img src={previewImg} alt="preview" className="h-56 w-56 object-cover rounded-xl" />
        </div>
      )}
    </div>
  );
}
